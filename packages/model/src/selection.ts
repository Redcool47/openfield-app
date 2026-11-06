/**
 * The three-level selection model.
 *
 *   1. **Text**     - a caret or range inside one block.
 *   2. **Block**    - one or more whole blocks, entered with Esc or by dragging
 *                     in the left margin. Has its own clipboard, delete,
 *                     indent, duplicate and drag behaviour.
 *   3. **Page**     - every block on the page, reached by pressing select-all
 *                     twice.
 *
 * Why this is its own type and not a ProseMirror `NodeSelection`
 * ------------------------------------------------------------
 * Because the three levels do genuinely different things. At text level Delete
 * removes characters. At block level Delete removes blocks *and their
 * subtrees*. At block level Enter re-enters text editing rather than inserting a
 * newline. At block level typing a character replaces the block. None of that is
 * derivable from a single selection type, and getting it wrong is precisely
 * what makes an editor feel unlike the one the user knows.
 *
 * Anchoring
 * ---------
 * Block selection uses an anchor plus a focus, not a start/end pair, because the
 * user drags in one direction but Shift+Arrow expands in the other. Storing both
 * explicitly means rendering a highlight for "anchor -> focus" is unambiguous.
 */

import type { Doc } from './doc.js';
import { childrenOf, get, subtreeIds } from './doc.js';
import { textOf, type InlineContent } from './rich-text.js';
import type { Block } from './doc.js';

export type SelectionLevel = 'text' | 'block' | 'page';

export interface TextSelection {
  level: 'text';
  blockId: string;
  from: number;
  to: number;
}

export interface BlockSelection {
  level: 'block';
  /** The block the selection started from. */
  anchorId: string;
  /** The block the selection currently ends at. */
  focusId: string;
}

export interface PageSelection {
  level: 'page';
}

export type Selection = TextSelection | BlockSelection | PageSelection;

export function textSelection(blockId: string, from: number, to = from): TextSelection {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.max(from, to);
  return { level: 'text', blockId, from: lo, to: hi };
}

export function caretAt(blockId: string, offset: number): TextSelection {
  return { level: 'text', blockId, from: offset, to: offset };
}

export function isCollapsed(selection: Selection): boolean {
  return selection.level === 'text' && selection.from === selection.to;
}

export function blockSelection(anchorId: string, focusId = anchorId): BlockSelection {
  return { level: 'block', anchorId, focusId };
}

export function pageSelection(): PageSelection {
  return { level: 'page' };
}

/** Document-order index of every block, used to normalise ranges. */
export function orderIndex(doc: Doc): Map<string, number> {
  const order: string[] = [];
  const visit = (ids: string[]) => {
    for (const id of ids) {
      const b = doc.blocks[id];
      if (!b) continue;
      order.push(id);
      visit(b.children);
    }
  };
  visit(doc.roots);
  const map = new Map<string, number>();
  order.forEach((id, i) => map.set(id, i));
  return map;
}

/** The blocks a selection covers, in document order. */
export function selectedBlocks(doc: Doc, selection: Selection): Block[] {
  if (selection.level === 'text') {
    const b = doc.blocks[selection.blockId];
    return b ? [b] : [];
  }
  if (selection.level === 'page') {
    const out: Block[] = [];
    const visit = (ids: string[]) => {
      for (const id of ids) {
        const b = doc.blocks[id];
        if (!b) continue;
        out.push(b);
        visit(b.children);
      }
    };
    visit(doc.roots);
    return out;
  }
  const index = orderIndex(doc);
  const a = index.get(selection.anchorId) ?? 0;
  const f = index.get(selection.focusId) ?? a;
  const lo = Math.min(a, f);
  const hi = Math.max(a, f);
  const all = [...index.keys()].filter((id) => {
    const i = index.get(id)!;
    return i >= lo && i <= hi;
  });
  all.sort((x, y) => index.get(x)! - index.get(y)!);
  return all.map((id) => doc.blocks[id]!).filter(Boolean);
}

/** True when the selection is anchored at the very start of its block. */
export function atBlockStart(doc: Doc, selection: TextSelection): boolean {
  return selection.from === 0 && selection.to === 0;
}

/**
 * All blocks *fully* inside the selection.
 *
 * Used for structural operations such as indent and duplicate. A partially
 * covered block is excluded because indenting half a paragraph would split it
 * from its own text, which is never what the user meant.
 */
export function fullySelectedBlocks(doc: Doc, selection: Selection): string[] {
  if (selection.level !== 'block' && selection.level !== 'page') return [];
  return selectedBlocks(doc, selection)
    .filter((b) => b.type !== 'divider' || true)
    .map((b) => b.id);
}

/**
 * Descend from a block selection into text editing at `offset`.
 * Mirrors "press Enter on a selected block".
 */
export function enterTextSelection(selection: BlockSelection, offset: number): TextSelection {
  return caretAt(selection.focusId, offset);
}

/** Escape from text selection to block selection on the current block. */
export function toBlockSelection(selection: TextSelection): BlockSelection {
  return blockSelection(selection.blockId, selection.blockId);
}

/** Pressing select-all once selects the current block's text. */
export function selectAllInBlock(doc: Doc, selection: Selection): Selection {
  if (selection.level !== 'text') return selection;
  const block = doc.blocks[selection.blockId];
  if (!block) return selection;
  return textSelection(selection.blockId, 0, textOf(block.content).length);
}

/** Pressing select-all again selects every block on the page. */
export function selectAllPage(selection: Selection): Selection {
  if (selection.level === 'text' || selection.level === 'block') return pageSelection();
  return selection;
}

/** The text a selection covers, for clipboard and export. */
export function selectedText(doc: Doc, selection: Selection): string {
  if (selection.level === 'text') {
    const b = doc.blocks[selection.blockId];
    if (!b) return '';
    return textOf(b.content).slice(selection.from, selection.to);
  }
  return selectedBlocks(doc, selection)
    .map((b) => textOf(b.content))
    .join('\n');
}

/**
 * Move the block selection by `delta` places in document order.
 * Returns null at either end so the caller can decide whether to fall through
 * to the previous or next block.
 */
export function shiftBlockSelection(
  doc: Doc,
  selection: BlockSelection,
  delta: number,
): BlockSelection | null {
  const index = orderIndex(doc);
  const ids = [...index.keys()];
  const pos = ids.indexOf(selection.focusId);
  if (pos < 0) return null;
  const next = pos + delta;
  if (next < 0 || next >= ids.length) return null;
  return blockSelection(selection.anchorId, ids[next]!);
}

/**
 * Expand a block selection to include `id`, keeping the anchor fixed.
 * The focus moves; the anchor does not.
 */
export function extendBlockSelection(doc: Doc, selection: BlockSelection, id: string): BlockSelection {
  void doc;
  return blockSelection(selection.anchorId, id);
}

/** Ids to remove for a delete at this selection level. */
export function deletableIds(doc: Doc, selection: Selection): string[] {
  const blocks = selectedBlocks(doc, selection);
  const out = new Set<string>();
  for (const b of blocks) {
    // Never delete a container and then delete its children twice.
    if ([...out].some((id) => isInsideSubtree(doc, id, b.id))) continue;
    for (const id of subtreeIds(doc, b.id)) out.add(id);
  }
  return [...out];
}

function isInsideSubtree(doc: Doc, ancestorId: string, maybeId: string): boolean {
  return subtreeIds(doc, ancestorId).includes(maybeId);
}

/**
 * Where the caret should land when a selection is replaced by typed text.
 * A block selection collapses to the start of its focus block.
 */
export function collapseForTyping(doc: Doc, selection: Selection): TextSelection {
  if (selection.level === 'text') return caretAt(selection.blockId, selection.from);
  const block = selectedBlocks(doc, selection).at(-1);
  return caretAt(block ? block.id : doc.roots[0] ?? '', 0);
}

/** Content of a block as plain text, used by the clipboard and export paths. */
export function blockPlainText(doc: Doc, id: string): string {
  const b = doc.blocks[id];
  return b ? textOf(b.content) : '';
}

/** All runs of a block, used by structured clipboard payloads. */
export function blockRuns(doc: Doc, id: string): InlineContent {
  return get(doc, id).content.runs;
}

/** Children ids visible to the user, honouring collapsed state. */
export function visibleChildren(doc: Doc, id: string): string[] {
  const b = doc.blocks[id];
  if (!b || b.collapsed) return [];
  return childrenOf(doc, id);
}