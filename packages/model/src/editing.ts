/**
 * Editing operations.
 *
 * These are the behaviours that decide whether the editor *feels* right. Each
 * one is expressed as "what happens on Enter / Backspace / Tab / Esc in this
 * block type", which is the part users notice instantly when it differs from
 * what they are used to.
 *
 * Every function takes a `TxContext` and declares the blocks it touches, so the
 * caller can wrap it in one transaction without guessing.
 */

import { newId } from '@ow/geom';
import type { Block, Doc } from './doc.js';
import {
  createDoc,
  get,
  insert,
  moveBlock,
  repairPositions,
  restoreBlock,
  setContent,
  setProps,
  setType,
  siblingsOf,
  subtreeIds,
  trashBlock,
  ancestors,
  nextSibling,
} from './doc.js';
import {
  emptyContent,
  graphemeStartBefore,
  normalizeContent,
  plain,
  sliceText,
  spliceText,
  textOf,
  type Content,
} from './rich-text.js';
import { blockDef } from './registry.js';
import type { TxContext } from './transaction.js';

export interface Caret {
  blockId: string;
  offset: number;
}

export interface EditResult {
  caret: Caret;
  /** Set when the operation created or removed blocks. */
  changed?: boolean;
}

/**
 * Enter.
 *
 * The rules, and why each exists:
 *  - code blocks insert a newline, because a code block is not a paragraph;
 *  - Enter on an *empty* list item exits the list into a plain paragraph, so
 *    there is always a way out and no orphan bullet is left behind;
 *  - Enter on an empty heading or quote also drops to a paragraph;
 *  - Enter anywhere else splits into a sibling, carrying the tail of the
 *    current content into the new block.
 *
 * Splits happen *after* the caret and the tail is moved verbatim. Leading
 * whitespace in the tail is deliberately preserved: a space typed in the middle
 * of a sentence must not disappear when Enter is pressed, and there is no
 * reliable way to tell indentation whitespace from real content whitespace.
 * Indentation is expressed by the block tree, not by text.
 */
export function insertLineBreak(doc: Doc, tx: TxContext, caret: Caret): EditResult {
  const block = get(doc, caret.blockId);
  if (blockDef(block.type).enter === 'newline') {
    const content = spliceText(block.content.runs, caret.offset, caret.offset, '\n');
    tx.touch(block.id);
    setContent(doc, block.id, content);
    return { caret: { blockId: block.id, offset: caret.offset + 1 } };
  }

  const before = sliceText(block.content.runs, 0, caret.offset);
  const after = sliceText(block.content.runs, caret.offset, textOf(block.content).length);
  const definition = blockDef(block.type);
  const exitsList =
    definition.enter === 'exit' && textOf(block.content).trim().length === 0;
  const demotes =
    (definition.enter === 'exit' || definition.enter === 'split') &&
    textOf(before).trim().length === 0 &&
    before.length === 0;

  tx.touch(block.id);

  if (exitsList || (demotes && definition.unwrapsTo)) {
    // Convert in place, then split normally so the caret lands in fresh text.
    if (exitsList) setType(doc, block.id, 'paragraph');
    else setType(doc, block.id, definition.unwrapsTo!);
    const demoted = get(doc, block.id);
    const head = sliceText(demoted.content.runs, 0, caret.offset);
    const tail = sliceText(demoted.content.runs, caret.offset, textOf(demoted.content).length);
    setContent(doc, block.id, head);
    const fresh = insert(doc, {
      type: 'paragraph',
      parentId: demoted.parentId,
      beforeId: nextSibling(doc, demoted.id) ?? null,
      content: tail,
    });
    tx.touch(fresh.id);
    return { caret: { blockId: fresh.id, offset: 0 }, changed: true };
  }

  const definition2 = blockDef(block.type);
  const siblingType =
    definition2.enter === 'exit' ? block.type : definition2.unwrapsTo ?? 'paragraph';

  tx.touch(block.id);
  setContent(doc, block.id, before);

  const fresh = insert(doc, {
    type: siblingType,
    parentId: block.parentId,
    beforeId: nextSibling(doc, block.id) ?? null,
    content: after,
  });
  tx.touch(fresh.id);

  // Enter in a to-do list creates a sibling that starts unchecked, which is what
  // users expect when breaking up a checklist.
  if (siblingType === 'todo' && !get(doc, fresh.id).props.checked) {
    tx.touch(fresh.id);
    setProps(doc, fresh.id, { checked: false });
  }
  return { caret: { blockId: fresh.id, offset: 0 }, changed: true };
}

/**
 * Backspace at offset 0.
 *
 * Order of attempts, which is the part that matters:
 *  1. if the block has content, remove the leading character (not handled here);
 *  2. if the block is a styled block, turn it into a paragraph first, leaving
 *     the caret where it was;
 *  3. if it has children, merge the children into the parent so pressing
 *     Backspace on a parent never orphans a subtree;
 *  4. otherwise merge into the previous sibling, appending this block's children
 *     to the previous block's children and putting the caret at the join.
 */
export function mergeBackward(doc: Doc, tx: TxContext, caret: Caret): EditResult {
  const block = get(doc, caret.blockId);
  const definition = blockDef(block.type);

  if (caret.offset > 0) {
    const t = textOf(block.content);
    const from = graphemeStartBefore(t, caret.offset);
    const content = spliceText(block.content.runs, from, caret.offset, '');
    tx.touch(block.id);
    setContent(doc, block.id, content);
    return { caret: { blockId: block.id, offset: from } };
  }

  if (definition.unwrapsTo) {
    tx.touch(block.id);
    setType(doc, block.id, definition.unwrapsTo);
    return { caret };
  }

  const prev = previousBlock(doc, block.id);

  if (!prev && block.children.length > 0 && block.parentId === null) {
    // Nothing to merge into and this block holds a subtree: Backspace lifts the
    // children up to be siblings rather than deleting them, so a subtree is
    // never lost by pressing Backspace where the user only meant to outdent.
    tx.touch(block.id);
    const orphans = [...block.children];
    const list = siblingsOf(doc, null);
    const at = list.indexOf(block.id);
    for (const [i, childId] of orphans.entries()) {
      const child = doc.blocks[childId]!;
      child.parentId = null;
      list.splice(at + 1 + i, 0, childId);
      tx.touch(childId);
    }
    block.children = [];
    repairPositions(doc);
    return { caret: { blockId: block.id, offset: 0 }, changed: true };
  }

  if (!prev) {
    // Nothing before the first block in the document: Backspace at offset 0 has
    // nowhere to go and must do nothing. Deleting a character here is the job
    // of pressing Backspace at offset 1, which is not ambiguous.
    return { caret };
  }

  const prevContent = get(doc, prev).content;
  const at = textOf(prevContent).length;
  const merged = normalizeContent({ runs: [...sliceText(prevContent.runs, 0, at), ...block.content.runs] });

  tx.touch(prev);
  setContent(doc, prev, merged);

  // Children of the absorbed block become children of the previous one.
  if (block.children.length) {
    for (const childId of block.children) {
      doc.blocks[childId]!.parentId = prev;
    }
    const target = get(doc, prev);
    target.children.push(...block.children);
    block.children = [];
  }
  tx.remove(block.id);
  repairPositions(doc);
  return { caret: { blockId: prev, offset: at }, changed: true };
}

/** The block before `id` in document order, descending into the previous subtree. */
export function previousBlock(doc: Doc, id: string): string | null {
  let current = get(doc, id);
  for (let guard = 0; guard < 10_000; guard += 1) {
    const list = siblingsOf(doc, current.parentId);
    const at = list.indexOf(current.id);
    if (at > 0) {
      // Walk to the deepest last descendant of the preceding sibling, because
      // that is the block visually above this one.
      let candidate = list[at - 1]!;
      for (let inner = 0; inner < 10_000; inner += 1) {
        const block = doc.blocks[candidate];
        if (!block || block.children.length === 0) break;
        candidate = block.children[block.children.length - 1]!;
      }
      return candidate;
    }
    if (current.parentId === null) return null;
    current = get(doc, current.parentId);
  }
  return null;
}

/** The block after `id` in document order. */
export function nextBlock(doc: Doc, id: string): string | null {
  const block = get(doc, id);
  if (block.children.length > 0) return block.children[0]!;
  let current: Block = block;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const list = siblingsOf(doc, current.parentId);
    const at = list.indexOf(current.id);
    if (at >= 0 && at + 1 < list.length) return list[at + 1]!;
    if (current.parentId === null) return null;
    current = get(doc, current.parentId);
  }
  return null;
}

export interface MoveResult {
  caret: Caret;
  changed: boolean;
}

/**
 * Tab / Shift+Tab.
 *
 * A block with no previous sibling cannot be outdented further; it moves out
 * only if its parent is not the document root. Indenting a first child is a
 * no-op rather than an error, so holding Tab on an indented list does nothing
 * visible instead of throwing.
 */
export function indent(doc: Doc, tx: TxContext, id: string): MoveResult {
  const block = get(doc, id);
  const prev = previousSiblingId(doc, id);
  if (!prev) return { caret: { blockId: id, offset: 0 }, changed: false };
  tx.touch(id);
  tx.touch(block.parentId ?? '');
  moveBlock(doc, id, prev, null);
  for (const b of subtreeIds(doc, id)) tx.touch(b);
  repairPositions(doc);
  return { caret: { blockId: id, offset: 0 }, changed: true };
}

export function outdent(doc: Doc, tx: TxContext, id: string): MoveResult {
  const block = get(doc, id);
  const parentId = block.parentId;
  if (parentId === null) return { caret: { blockId: id, offset: 0 }, changed: false };
  const grandParentId = get(doc, parentId).parentId;
  tx.touch(id);
  tx.touch(parentId);
  tx.touch(grandParentId ?? '');
  moveBlock(doc, id, grandParentId, nextSibling(doc, parentId) ?? null);
  for (const b of subtreeIds(doc, id)) tx.touch(b);
  repairPositions(doc);
  return { caret: { blockId: id, offset: 0 }, changed: true };
}

function previousSiblingId(doc: Doc, id: string): string | null {
  const list = siblingsOf(doc, doc.blocks[id]?.parentId ?? null);
  const at = list.indexOf(id);
  return at > 0 ? list[at - 1]! : null;
}

/** Move a block (and its subtree) one place up or down among its siblings. */
export function moveSibling(doc: Doc, tx: TxContext, id: string, direction: -1 | 1): MoveResult {
  const block = get(doc, id);
  const list = siblingsOf(doc, block.parentId);
  const at = list.indexOf(id);
  const target = at + direction;
  if (at < 0 || target < 0 || target >= list.length) {
    return { caret: { blockId: id, offset: 0 }, changed: false };
  }
  tx.touch(id);
  tx.touch(list[at]!);
  tx.touch(list[target]!);
  if (block.parentId !== null) tx.touch(block.parentId);
  const moved = list.splice(at, 1)[0]!;
  list.splice(target, 0, moved);
  repairPositions(doc);
  return { caret: { blockId: id, offset: 0 }, changed: true };
}

/** Convert a block to another type, keeping its content and children. */
export function turnInto(doc: Doc, tx: TxContext, id: string, type: string): EditResult {
  const block = get(doc, id);
  if (block.type === type) return { caret: { blockId: id, offset: 0 } };
  const allowed = blockDef(block.type).turnInto;
  if (allowed && !allowed.includes(type)) {
    throw new Error(`cannot turn ${block.type} into ${type}`);
  }
  tx.touch(id);
  for (const b of subtreeIds(doc, id)) tx.touch(b);
  setType(doc, id, type);
  return { caret: { blockId: id, offset: 0 }, changed: true };
}

/** Toggle a to-do checkbox, or the open state of a toggle or heading. */
export function toggleOpen(doc: Doc, tx: TxContext, id: string): EditResult {
  const block = get(doc, id);
  tx.touch(id);
  if (block.type === 'todo') {
    setProps(doc, id, { checked: !block.props.checked });
  } else if (block.type === 'toggle') {
    block.collapsed = !block.collapsed;
    block.updatedAt = Date.now();
  } else {
    return { caret: { blockId: id, offset: 0 } };
  }
  return { caret: { blockId: id, offset: 0 }, changed: true };
}

/** Move a page or block to the trash. Rows are kept so it can be restored. */
export function moveToTrash(doc: Doc, tx: TxContext, id: string): void {
  tx.mark(id);
  trashBlock(doc, id);
}

/** Delete a block and its subtree for good. */
export function purgeBlock(doc: Doc, tx: TxContext, id: string): void {
  tx.remove(id);
}

export function restore(doc: Doc, tx: TxContext, id: string): void {
  tx.touch(id);
  for (const b of subtreeIds(doc, id)) tx.touch(b);
  restoreBlock(doc, id);
  // Restoring under a parent that no longer exists puts the page at the top
  // level rather than losing it.
  const block = get(doc, id);
  if (block.parentId !== null && !doc.blocks[block.parentId]) {
    block.parentId = null;
    doc.roots.push(id);
    repairPositions(doc);
  }
}

export interface TypedPage {
  doc: Doc;
  rootId: string;
}

/** A fresh page document with one empty paragraph. */
export function emptyPage(id = newId()): TypedPage {
  const doc = createDoc();
  const root = insert(doc, { id, type: 'paragraph' });
  return { doc, rootId: root.id };
}

/** A block whose children were lifted out, used when dragging out of a nesting. */
export function flattenToSiblings(doc: Doc, tx: TxContext, id: string): void {
  const block = get(doc, id);
  if (block.children.length === 0) return;
  tx.touch(id);
  const orphans = [...block.children];
  const list = siblingsOf(doc, block.parentId);
  const at = list.indexOf(id);
  for (const [i, childId] of orphans.entries()) {
    doc.blocks[childId]!.parentId = block.parentId;
    list.splice(at + 1 + i, 0, childId);
    tx.touch(childId);
  }
  block.children = [];
  repairPositions(doc);
}