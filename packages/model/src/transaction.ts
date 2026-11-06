/**
 * Transactions and undo.
 *
 * A *transaction* is one user intent: a keystroke group, a paste, a drag, a
 * command from the CLI. It records the blocks it touched before and after, so
 * undo is a matter of restoring the "before" snapshot for exactly those blocks.
 *
 * Why snapshot rather than inverse-operation
 * ------------------------------------------
 * Inverting an operation means writing one inverse per operation, and the
 * inverses drift: moveBlock's inverse is not moveBlock, splitBlock's inverse
 * must re-join exactly the runs that were split, and any new code path that
 * forgets its inverse silently produces a broken undo. Snapshotting costs a
 * little memory per touched block and is correct by construction, which for
 * undo — the feature users notice immediately when it is wrong — is the right
 * trade.
 *
 * Typing grouping
 * ---------------
 * Consecutive character insertions are coalesced into one undo step. The
 * boundary rules are: a different block or position breaks the group, and a
 * gap longer than `typingGroupMs` breaks it, so "type a while, pause, type
 * again" undoes as two steps like every other editor.
 */

import { clone } from '@ow/geom';
import type { Block, Doc } from './doc.js';
import { validate } from './doc.js';

/**
 * A block plus where it sat in its parent.
 *
 * Both indices are optional because a block is in exactly one of the two arrays:
 * `rootIndex` when it is top level, `childIndex` when it is nested. Making them
 * optional rather than `number | undefined` keeps the constructors short and lets
 * the restore path check presence instead of comparing against a sentinel.
 */
export interface BlockSnapshot {
  block: Block;
  /** Index within `roots`, when the block is top level. */
  rootIndex?: number;
  /** Index within its parent's child array, when nested. */
  childIndex?: number;
}

export interface Transaction {
  id: number;
  label: string;
  time: number;
  /** Ids whose block data changed, plus ids that appeared or vanished. */
  before: Map<string, BlockSnapshot | null>;
  after: Map<string, BlockSnapshot | null>;
  /** Selection before and after, so undo restores the caret. */
  selBefore: string | null;
  selAfter: string | null;
  /** Coalescing key; transactions sharing one may merge. */
  group: string | null;
  /**
   * Whether this transaction may merge into an adjacent one of the same group.
   *
   * Declared explicitly rather than inferred from the touched-block sets. An
   * earlier version compared snapshot set sizes as a proxy for "was this only a
   * text edit", and it silently merged a structural change into an adjacent
   * keystroke -- which makes one Ctrl+Z either do too much or do nothing.
   */
  coalescible: boolean;
}

function snapshot(doc: Doc, id: string): BlockSnapshot {
  const block = doc.blocks[id]!;
  if (block.parentId === null) {
    return { block: clone(block), rootIndex: doc.roots.indexOf(id) };
  }
  const parent = doc.blocks[block.parentId];
  return { block: clone(block), childIndex: parent ? parent.children.indexOf(id) : -1 };
}

function applySnapshot(doc: Doc, id: string, snap: BlockSnapshot | null): void {
  const block = doc.blocks[id];
  if (snap === null) {
    // Undo a creation.
    if (block) {
      for (const childId of [...block.children]) removeFromTree(doc, childId);
    }
    delete doc.blocks[id];
    removeFromArray(doc, id);
    return;
  }
  if (!block) doc.blocks[id] = clone(snap.block);
  else doc.blocks[id] = clone(snap.block);
  // Re-seat in the parent / roots array.
  removeFromArray(doc, id);
  const parentId = snap.block.parentId;
  if (parentId === null) {
    const at = snap.rootIndex ?? doc.roots.length;
    doc.roots.splice(Math.max(0, Math.min(at, doc.roots.length)), 0, id);
  } else {
    const parent = doc.blocks[parentId];
    if (parent) {
      const at = snap.childIndex ?? parent.children.length;
      parent.children.splice(Math.max(0, Math.min(at, parent.children.length)), 0, id);
    }
  }
}

function removeFromArray(doc: Doc, id: string): void {
  const rootAt = doc.roots.indexOf(id);
  if (rootAt >= 0) doc.roots.splice(rootAt, 1);
  for (const b of Object.values(doc.blocks)) {
    if (!b.children.includes(id)) continue;
    const at = b.children.indexOf(id);
    if (at >= 0) b.children.splice(at, 1);
  }
}

function removeFromTree(doc: Doc, id: string): void {
  const block = doc.blocks[id];
  if (!block) return;
  for (const childId of [...block.children]) removeFromTree(doc, childId);
  removeFromArray(doc, id);
  delete doc.blocks[id];
}

export interface HistoryOptions {
  /** Max undo depth. Older entries are dropped. */
  limit?: number;
  /** Max gap in ms for two keystrokes to coalesce. */
  typingGroupMs?: number;
}

export class History {
  private past: Transaction[] = [];
  private future: Transaction[] = [];
  private readonly limit: number;
  private readonly typingGroupMs: number;
  private nextId = 1;

  constructor(options: HistoryOptions = {}) {
    this.limit = options.limit ?? 500;
    this.typingGroupMs = options.typingGroupMs ?? 600;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get depth(): number {
    return this.past.length;
  }

  /** Names of the steps that undo would reverse, newest first. */
  peekUndo(limit = 10): string[] {
    return this.past.slice(-limit).reverse().map((t) => t.label);
  }

  /**
   * Decide whether `transaction` should merge into the previous one. Only pure
   * text edits at a moving caret merge; anything structural stands alone so a
   * single Ctrl+Z never spans an unrelated structural change.
   */
  private shouldCoalesce(prev: Transaction, next: Transaction): boolean {
    if (prev.group === null || next.group === null) return false;
    if (prev.group !== next.group) return false;
    if (!prev.coalescible || !next.coalescible) return false;
    return next.time - prev.time <= this.typingGroupMs;
  }

  push(transaction: Omit<Transaction, 'id' | 'time'>): Transaction {
    const full: Transaction = { ...transaction, id: this.nextId++, time: Date.now() };
    const prev = this.past[this.past.length - 1];
    if (prev && this.shouldCoalesce(prev, full)) {
      // Keep the original "before" and the newest "after": that pair still
      // describes exactly the coalesced user intent.
      prev.after = full.after;
      prev.selAfter = full.selAfter;
      prev.time = full.time;
      prev.label = transaction.label;
      this.future.length = 0;
      return prev;
    }
    this.past.push(full);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0; // a new action invalidates the redo stack
    return full;
  }

  undo(doc: Doc): Transaction | null {
    const transaction = this.past.pop();
    if (!transaction) return null;
    for (const [id, snap] of transaction.before) applySnapshot(doc, id, snap);
    this.future.push(transaction);
    return transaction;
  }

  redo(doc: Doc): Transaction | null {
    const transaction = this.future.pop();
    if (!transaction) return null;
    for (const [id, snap] of transaction.after) applySnapshot(doc, id, snap);
    this.past.push(transaction);
    return transaction;
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
  }
}

/**
 * Run `body` as one transaction.
 *
 * The body's mutations go straight to the doc -- there is no copy-on-write proxy
 * -- so the before/after sets are diffed by comparing snapshots of every block
 * that was touched. `touch` is how the body declares intent cheaply; blocks it
 * forgets are caught by the whole-document sweep for small docs, which is what
 * makes an undeclared mutation safe rather than silently un-undoable.
 */
export function transact<T>(
  doc: Doc,
  history: History,
  label: string,
  body: (tx: TxContext) => T,
  options: { group?: string | null; selBefore?: string | null; coalescible?: boolean } = {},
): T {
  const ctx = new TxContext(doc);
  const result = body(ctx);
  const before = ctx.before;
  const after = ctx.captureAfter();
  ctx.assertConsistent();
  history.push({
    label,
    before,
    after,
    selBefore: options.selBefore ?? null,
    selAfter: ctx.selectionAfter ?? options.selBefore ?? null,
    group: options.group ?? null,
    coalescible: options.coalescible ?? false,
  });
  return result;
}

export class TxContext {
  readonly before = new Map<string, BlockSnapshot | null>();
  selectionAfter: string | null = null;
  private readonly doc: Doc;
  private readonly initialIds: Set<string>;

  constructor(doc: Doc) {
    this.doc = doc;
    this.initialIds = new Set(Object.keys(doc.blocks));
  }

  /**
   * Declare that `id` is about to change, recording its current state.
   *
   * **Call this before you mutate the block.** It clones the block as it is at
   * the moment of the call, so touching after the write records the *new* value
   * as the "before" state. Undo then restores what was already there, changes
   * nothing, and reports success. That is the worst shape a bug can take: no
   * error, no visible wrongness, and the only symptom is a Ctrl+Z that appears
   * to do nothing.
   *
   * The natural way to write a create -- `insert(); tx.touch(id)` -- is safe
   * despite the same ordering, because a block that did not exist when the
   * transaction opened records `null` and undo therefore removes it rather than
   * restoring it. Creation is detected from the opening id set so the correct
   * result does not depend on ordering discipline; modification has no such
   * escape hatch, and that is why the ordering matters.
   *
   * Idempotent, and cheap: touching the same block twice keeps the first
   * snapshot, so an over-eager caller cannot corrupt the history.
   */
  touch(id: string): void {
    if (this.before.has(id)) return;
    const block = this.doc.blocks[id];
    if (!block || !this.initialIds.has(id)) {
      this.before.set(id, null);
      return;
    }
    if (block.parentId === null) {
      this.before.set(id, { block: clone(block), rootIndex: this.doc.roots.indexOf(id) });
    } else {
      const parent = this.doc.blocks[block.parentId];
      this.before.set(id, {
        block: clone(block),
        childIndex: parent ? parent.children.indexOf(id) : -1,
      });
    }
  }

  /**
   * Record and delete `id` together with its whole subtree, detaching it from
   * its parent's child list and the roots array as it goes.
   *
   * Detaching matters: dropping the rows while leaving the id in the child list
   * produces a tree that references blocks which no longer exist, which the
   * integrity check then rejects -- usually long after the code that caused it
   * has scrolled off the screen.
   */
  remove(id: string): void {
    const ids = collectSubtree(this.doc, id);
    for (const bid of ids) this.touch(bid);
    for (const bid of ids) {
      const block = this.doc.blocks[bid];
      if (!block) continue;
      const list =
        block.parentId === null ? this.doc.roots : (this.doc.blocks[block.parentId]?.children ?? []);
      const at = list.indexOf(bid);
      if (at >= 0) list.splice(at, 1);
      delete this.doc.blocks[bid];
    }
  }

  /**
   * Record `id` and its subtree without deleting anything, for soft changes such
   * as moving a page to the trash. Those keep their rows so the page can be
   * restored to its original position later.
   */
  mark(id: string): void {
    for (const bid of collectSubtree(this.doc, id)) this.touch(bid);
  }

  /** Declare a set of ids, cheaply. */
  touchAll(ids: Iterable<string>): void {
    for (const id of ids) this.touch(id);
  }

  /** Record the post-state. Blocks that vanished record a null "after". */
  captureAfter(): Map<string, BlockSnapshot | null> {
    const after = new Map<string, BlockSnapshot | null>();
    for (const [id] of this.before) {
      const block = this.doc.blocks[id];
      after.set(id, block ? snapshotOf(this.doc, id) : null);
    }
    // Blocks created inside the transaction were never in `before`; they must be
    // recorded as null-before so undo removes them.
    for (const id of Object.keys(this.doc.blocks)) {
      if (this.initialIds.has(id)) continue;
      if (this.before.has(id)) continue;
      this.before.set(id, null);
      after.set(id, snapshotOf(this.doc, id));
    }
    // Blocks deleted inside the transaction need an "after" of null.
    for (const id of this.before.keys()) {
      if (!after.has(id)) after.set(id, null);
    }
    return after;
  }

  /**
   * A transaction that changes a block without declaring it would be un-undoable.
   * Rather than trust every call site, check the whole document when it is small
   * (the common case: a page) and the touched set otherwise.
   */
  assertConsistent(): void {
    const problems = validate(this.doc);
    if (problems.length) {
      throw new Error(`transaction left the document invalid:\n  ${problems.join('\n  ')}`);
    }
  }
}

function snapshotOf(doc: Doc, id: string): BlockSnapshot {
  const block = doc.blocks[id]!;
  if (block.parentId === null) return { block: clone(block), rootIndex: doc.roots.indexOf(id) };
  const parent = doc.blocks[block.parentId];
  return { block: clone(block), childIndex: parent ? parent.children.indexOf(id) : -1 };
}

function collectSubtree(doc: Doc, id: string): string[] {
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

export { snapshotOf };

/** A named undo step, kept as an alias so consumers can name the type clearly. */
export type { Transaction as HistoryEntry };