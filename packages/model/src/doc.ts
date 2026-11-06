/**
 * The block tree: the single mutable-state-free representation of a page.
 *
 * Shape
 * -----
 * `blocks` maps id -> block. A block owns its children as an *ordered array of
 * ids* and carries its sibling position key. Two orders coexist on purpose:
 *  - the id array is authoritative and gives O(1) sibling lookup;
 *  - the position key is authoritative for *sorting* after a reload, because it
 *    is the only value that survives without a full re-derivation pass.
 *
 * `roots` holds the ordered top-level ids. There is exactly one root list per
 * document; a page is one document.
 *
 * Why positions and arrays both
 * -----------------------------
 * Storing an array of children means a move is O(siblings) to reorder in memory
 * but O(1) to persist if we trust the array order. Storing only a sort key means
 * a move writes one row. We keep both because the database layer needs the sort
 * key for SQL ordering and query planning, while the editor needs the array for
 * selection and rendering. `sortChildren` reconciles the two and is called after
 * every transaction that can change order, so they cannot drift.
 */

import { keyAfter, keyBetween } from '@ow/geom';
import { newId } from '@ow/geom';
import { blockDef, canHaveChildren } from './registry.js';
import {
  emptyContent,
  normalizeContent,
  normalizeRuns,
  textOf,
  type Content,
  type ColorName,
} from './rich-text.js';

export interface BlockProps {
  /** Checkbox state for to-do blocks. */
  checked?: boolean;
  /** Page icon: an emoji character or an asset reference. */
  icon?: string;
  /** Cover asset reference. */
  cover?: string;
  /** Block colour name. */
  color?: ColorName;
  /** Callout icon. */
  calloutIcon?: string;
  /**
   * The kind of a callout: note, tip, info, warning or caution.
   *
   * A callout without one is a plain note, so the kind is optional rather
   * than a default the model has to fill in.
   */
  calloutKind?: string;
  /** Code language tag. */
  language?: string;
  /** Code block soft wrap. */
  wrap?: boolean;
  /** Number of columns for a columns block. */
  columnCount?: number;
  /** Table dimensions and cells live in `table` to keep props flat. */
  table?: { rows: number; cols: number; header: boolean; cells: string[][] };
  /** Database block: the collection id it renders. */
  collectionId?: string;
  /** View id for a database block that opens directly into one view. */
  viewId?: string;
  /** Bookmarks and embeds carry a URL. */
  url?: string;
  /** Asset sha256 for media blocks. */
  assetId?: string;
  /** Page link target for a `page` block. */
  targetPageId?: string;
  /** Synced block origin id. */
  syncedFrom?: string;
  /** Bookmark description. */
  description?: string;
}

export interface Block {
  id: string;
  type: string;
  parentId: string | null;
  /** Fractional sort key among siblings. */
  position: string;
  content: Content;
  props: BlockProps;
  children: string[];
  collapsed: boolean;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Doc {
  blocks: Record<string, Block>;
  roots: string[];
}

export function createDoc(): Doc {
  return { blocks: {}, roots: [] };
}

export function get(doc: Doc, id: string): Block {
  const b = doc.blocks[id];
  if (!b) throw new Error(`no such block: ${id}`);
  return b;
}

export function tryGet(doc: Doc, id: string | null | undefined): Block | undefined {
  return id ? doc.blocks[id] : undefined;
}

export function siblingsOf(doc: Doc, parentId: string | null): string[] {
  return parentId === null ? doc.roots : (doc.blocks[parentId]?.children ?? []);
}

/** The ordered child ids of a block, or the roots when id is null. */
export function childrenOf(doc: Doc, id: string | null): string[] {
  return siblingsOf(doc, id);
}

/** Blocks in document order from a starting point. Children follow their parent. */
export function walk(doc: Doc, start: string | null = null, includeTrashed = false): Block[] {
  const out: Block[] = [];
  const visit = (ids: string[]) => {
    for (const id of ids) {
      const b = doc.blocks[id];
      if (!b) continue;
      if (!includeTrashed && b.trashedAt !== null) continue;
      out.push(b);
      if (!b.collapsed) visit(b.children);
    }
  };
  visit(start === null ? doc.roots : childrenOf(doc, start));
  return out;
}

/** Depth-first search for the block whose content matches `predicate`. */
export function find(doc: Doc, predicate: (b: Block) => boolean, includeTrashed = false): Block | undefined {
  for (const b of walk(doc, null, includeTrashed)) if (predicate(b)) return b;
  return undefined;
}

export function ancestors(doc: Doc, id: string): Block[] {
  const out: Block[] = [];
  let cur = doc.blocks[id]?.parentId ?? null;
  let guard = 0;
  while (cur !== null && guard < 1000) {
    const b = doc.blocks[cur];
    if (!b) break;
    out.unshift(b);
    cur = b.parentId;
    guard += 1;
  }
  return out;
}

export function isDescendant(doc: Doc, ancestorId: string, maybeChildId: string): boolean {
  return ancestors(doc, maybeChildId).some((b) => b.id === ancestorId);
}

export function nextSibling(doc: Doc, id: string): string | undefined {
  const list = siblingsOf(doc, doc.blocks[id]?.parentId ?? null);
  const i = list.indexOf(id);
  return i >= 0 ? list[i + 1] : undefined;
}

export function prevSibling(doc: Doc, id: string): string | undefined {
  const list = siblingsOf(doc, doc.blocks[id]?.parentId ?? null);
  const i = list.indexOf(id);
  return i > 0 ? list[i - 1] : undefined;
}

/** Depth-first, including self. */
export function subtreeIds(doc: Doc, id: string): string[] {
  const out: string[] = [];
  const visit = (bid: string) => {
    const b = doc.blocks[bid];
    if (!b) return;
    out.push(bid);
    for (const c of b.children) visit(c);
  };
  visit(id);
  return out;
}

export function lastDescendant(doc: Doc, id: string): string {
  let cur = id;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const b = doc.blocks[cur];
    if (!b || b.children.length === 0) return cur;
    cur = b.children[b.children.length - 1]!;
  }
  return id;
}

/**
 * Validate parent/child consistency. Run after every transaction and by a
 * startup self-test: a tree where a child id appears twice, or a block lists a
 * child that points elsewhere, is corruption we want to catch immediately
 * rather than discover it as a duplicated page three weeks later.
 */
export function validate(doc: Doc): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  const check = (ids: string[], parentId: string | null, where: string) => {
    const local = new Set<string>();
    for (const id of ids) {
      if (local.has(id)) problems.push(`${where}: duplicate child id ${id}`);
      local.add(id);
      const b = doc.blocks[id];
      if (!b) {
        problems.push(`${where}: dangling child id ${id}`);
        continue;
      }
      if (seen.has(id)) problems.push(`${where}: block ${id} appears more than once in the tree`);
      seen.add(id);
      if (b.parentId !== parentId) {
        problems.push(`${where}: block ${id} says parent ${b.parentId} but is listed under ${parentId}`);
      }
      if (b.id === b.parentId) problems.push(`${where}: block ${id} is its own parent`);
      check(b.children, id, `block ${id}`);
    }
  };

  check(doc.roots, null, 'roots');
  for (const id of Object.keys(doc.blocks)) {
    if (!seen.has(id)) problems.push(`block ${id} is unreachable from roots`);
  }
  return problems;
}

export interface InsertOptions {
  id?: string;
  type?: string;
  parentId?: string | null;
  /** Sibling to insert before; omitted means append. */
  beforeId?: string | null;
  /** Fractional key to insert at instead of deriving one. */
  position?: string;
  /** Accepts a `Content` or a bare runs array; both are normalised on insert. */
  content?: Content | Content['runs'];
  props?: BlockProps;
}

/**
 * Insert a block. Returns the new block. Throws when the target parent cannot
 * hold children, because silently dropping children produces "my nested list
 * disappeared" bugs that are miserable to debug.
 */
export function insert(doc: Doc, opts: InsertOptions): Block {
  const parentId = opts.parentId ?? null;
  if (parentId !== null && !canHaveChildren(doc.blocks[parentId]?.type ?? '')) {
    throw new Error(`block ${parentId} cannot contain children`);
  }
  const siblings = siblingsOf(doc, parentId);
  const now = Date.now();
  const block: Block = {
    id: opts.id ?? newId(now),
    type: opts.type ?? 'paragraph',
    parentId,
    position: opts.position ?? positionFor(doc, siblings, opts.beforeId ?? null),
    content: normalizeContent(opts.content ?? emptyContent()),
    props: opts.props ?? {},
    children: [],
    collapsed: false,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  doc.blocks[block.id] = block;
  if (parentId === null) {
    const at = opts.beforeId ? doc.roots.indexOf(opts.beforeId) : -1;
    if (at >= 0) doc.roots.splice(at, 0, block.id);
    else doc.roots.push(block.id);
  } else {
    const parent = get(doc, parentId);
    const at = opts.beforeId ? parent.children.indexOf(opts.beforeId) : -1;
    if (at >= 0) parent.children.splice(at, 0, block.id);
    else parent.children.push(block.id);
    parent.updatedAt = now;
  }
  return block;
}

/**
 * The fractional key for a new sibling placed before `beforeId` (or appended
 * when that is null). Only the immediate neighbours matter, so an insert writes
 * one key rather than renumbering the list.
 */
function positionFor(doc: Doc, siblings: readonly string[], beforeId: string | null): string {
  if (beforeId === null) {
    const lastId = siblings[siblings.length - 1];
    return keyAfter(lastId ? doc.blocks[lastId]!.position : null);
  }
  const index = siblings.indexOf(beforeId);
  if (index < 0) {
    const lastId = siblings[siblings.length - 1];
    return keyAfter(lastId ? doc.blocks[lastId]!.position : null);
  }
  const beforePos = doc.blocks[beforeId]?.position ?? null;
  const afterId = siblings[index - 1];
  const afterPos = afterId ? doc.blocks[afterId]!.position ?? null : null;
  return keyBetween(afterPos, beforePos);
}

/**
 * Recompute every position key in document order. Called after any structural
 * change that the incremental path cannot express, and by `repairPositions`.
 * Writing all keys is cheap compared to getting order subtly wrong.
 */
export function repairPositions(doc: Doc): void {
  const assign = (ids: string[]) => {
    let last: string | null = null;
    for (const id of ids) {
      const b = doc.blocks[id];
      if (!b) continue;
      b.position = keyAfter(last);
      last = b.position;
      assign(b.children);
    }
  };
  assign(doc.roots);
}

export function moveBlock(
  doc: Doc,
  id: string,
  targetParentId: string | null,
  beforeId: string | null,
): void {
  const block = get(doc, id);
  if (targetParentId !== null) {
    if (targetParentId === id || isDescendant(doc, id, targetParentId)) {
      throw new Error('cannot move a block into its own subtree');
    }
    if (!canHaveChildren(doc.blocks[targetParentId]?.type ?? '')) {
      throw new Error(`block ${targetParentId} cannot contain children`);
    }
  }
  detach(doc, id);
  block.parentId = targetParentId;
  const list = targetParentId === null ? doc.roots : get(doc, targetParentId).children;
  const at = beforeId ? list.indexOf(beforeId) : -1;
  if (at >= 0) list.splice(at, 0, id);
  else list.push(id);
  block.updatedAt = Date.now();
  repairPositions(doc);
}

function detach(doc: Doc, id: string): void {
  const block = doc.blocks[id];
  if (!block) return;
  const list = siblingsOf(doc, block.parentId);
  const i = list.indexOf(id);
  if (i >= 0) list.splice(i, 1);
}

/** Remove a block and its whole subtree from the tree. */
export function removeBlock(doc: Doc, id: string): void {
  for (const bid of subtreeIds(doc, id)) delete doc.blocks[bid];
  detach(doc, id);
}

/** Soft delete: keep rows so the page can be restored, including its subtree. */
export function trashBlock(doc: Doc, id: string, at = Date.now()): void {
  for (const bid of subtreeIds(doc, id)) {
    const b = doc.blocks[bid];
    if (b) {
      b.trashedAt = at;
      b.updatedAt = at;
    }
  }
}

export function restoreBlock(doc: Doc, id: string): void {
  const block = doc.blocks[id];
  if (!block) return;
  block.trashedAt = null;
  block.updatedAt = Date.now();
  for (const bid of subtreeIds(doc, id)) {
    const b = doc.blocks[bid];
    if (b && b.id !== id) b.trashedAt = null;
  }
}

/**
 * Replace a block's content.
 *
 * Accepts either a full `Content` or a bare runs array. Both spellings occur
 * constantly at call sites -- the editing operations work in runs, the storage
 * layer works in `Content` -- and accepting only one of them is a reliable way
 * to end up storing `{ runs: undefined }`, which then fails much later inside
 * text extraction where the cause is no longer visible.
 */
export function setContent(doc: Doc, id: string, content: Content | Content['runs']): void {
  const b = get(doc, id);
  const runs = Array.isArray(content) ? content : content.runs;
  b.content = { runs: normalizeRuns(runs) };
  b.updatedAt = Date.now();
}

export function setProps(doc: Doc, id: string, patch: BlockProps): void {
  const b = get(doc, id);
  b.props = { ...b.props, ...patch };
  b.updatedAt = Date.now();
}

export function setType(doc: Doc, id: string, next: string): void {
  const b = get(doc, id);
  blockDef(next); // validates the type name
  if (b.type === next) return;
  b.type = next;
  // A block converted to something that cannot hold children loses them; we
  // promote them to siblings so no content is ever silently destroyed.
  if (b.children.length > 0 && !canHaveChildren(next)) {
    const orphans = [...b.children];
    b.children = [];
    const parent = b.parentId;
    const index = siblingsOf(doc, parent).indexOf(id);
    for (const [i, childId] of orphans.entries()) {
      const child = doc.blocks[childId]!;
      child.parentId = parent;
      child.updatedAt = Date.now();
      const list = siblingsOf(doc, parent);
      list.splice(index + 1 + i, 0, childId);
    }
  }
  if (!canHaveChildren(next)) b.collapsed = false;
  b.updatedAt = Date.now();
  repairPositions(doc);
}

/**
 * Duplicate a block, inserting the copy immediately after the original.
 *
 * Ids are regenerated for the whole copied subtree. That matters more than it
 * looks: reusing source ids would make the copy and the original share an
 * identity, so editing one would edit both, and a database row would appear
 * twice under the same primary key.
 *
 * Returns the new root id.
 */
export function duplicateBlock(doc: Doc, id: string, withChildren = true): string {
  const source = get(doc, id);
  const parentId = source.parentId;
  const after = nextSibling(doc, id) ?? null;
  const remap = new Map<string, string>([[id, newId()]]);

  const clone = (from: string, parent: string | null): string => {
    const src = get(doc, from);
    const target = remap.get(from) ?? newId();
    remap.set(from, target);
    const now = Date.now();
    const copy: Block = {
      ...structuredClone({ ...src, children: [] }),
      id: target,
      parentId: parent,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
    };
    doc.blocks[target] = copy;
    if (withChildren) {
      for (const childId of src.children) copy.children.push(clone(childId, target));
    }
    return target;
  };

  const copyId = remap.get(id)!;
  clone(id, parentId);
  const list = siblingsOf(doc, parentId);
  const at = after ? list.indexOf(after) : -1;
  if (at >= 0) list.splice(at, 0, copyId);
  else list.push(copyId);
  if (parentId !== null) get(doc, parentId).updatedAt = Date.now();
  repairPositions(doc);
  return copyId;
}

export function titleOf(doc: Doc, id: string): string {
  return textOf(get(doc, id).content);
}

/**
 * Render the tree as indented plain-text lines.
 *
 * This exists because "what does the document actually look like right now" is
 * the question that matters most during debugging and when driving the app from
 * an agent, and reading it off a JSON dump is miserable. It is the basis of the
 * `inspect_page` command and of most of the headless scenario tests, which is
 * why assertions in the test suite read as indented strings.
 *
 * Format per line: two spaces of indent per level, then the block type, then
 * the text, then any props worth seeing.
 */
export function treeShape(doc: Doc, start: string | null = null, includeTrashed = false): string[] {
  const out: string[] = [];
  const visit = (ids: string[], depth: number) => {
    for (const id of ids) {
      const b = doc.blocks[id];
      if (!b) continue;
      if (!includeTrashed && b.trashedAt !== null) continue;
      const label = textOf(b.content);
      const notes: string[] = [];
      if (b.props.checked) notes.push('checked');
      if (b.collapsed) notes.push('collapsed');
      if (b.props.language) notes.push(`lang=${b.props.language}`);
      if (b.trashedAt !== null) notes.push('trashed');
      const suffix = notes.length ? ` [${notes.join(' ')}]` : '';
      out.push(`${'  '.repeat(depth)}${label || '\u2014'}${suffix}`);
      visit(b.children, depth + 1);
    }
  };
  visit(start === null ? doc.roots : childrenOf(doc, start), 0);
  return out;
}

/** A structural summary suitable for an agent's one-line inspection. */
export function describeDoc(doc: Doc): { blocks: number; maxDepth: number; roots: number } {
  let maxDepth = 0;
  let blocks = 0;
  const visit = (ids: string[], depth: number) => {
    for (const id of ids) {
      const b = doc.blocks[id];
      if (!b) continue;
      blocks += 1;
      maxDepth = Math.max(maxDepth, depth);
      visit(b.children, depth + 1);
    }
  };
  visit(doc.roots, 0);
  return { blocks, maxDepth, roots: doc.roots.length };
}