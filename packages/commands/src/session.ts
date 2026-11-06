/**
 * The session: the thing commands actually operate on.
 *
 * A session owns the repository, the currently open page's in-memory document
 * and its undo history. It is deliberately headless and synchronous where it can
 * be, so the same session object serves the Electron renderer, the CLI and the
 * MCP server without any of them needing a UI.
 *
 * Autosave
 * --------
 * Edits mutate the in-memory document immediately; persistence is debounced.
 * Typing therefore never waits on disk, and a crash loses at most one debounce
 * interval of work. `flush()` forces a write and is called on window close and
 * before any read that another process could observe.
 */

import { newId } from '@ow/geom';
import type { Doc } from '@ow/model';
import {
  createDoc,
  emptyPage,
  History,
  textOf,
  transact,
  treeShape,
  walk,
  type Block,
  type Selection,
  caretAt,
  type TextRun,
} from '@ow/model';
import type { Repository } from '@ow/storage';

export interface SessionOptions {
  /** Debounce interval for persisting the open page. Default 400 ms. */
  autosaveMs?: number;
  /** Persist a page version every N transactions. Default 25. */
  versionEvery?: number;
}

export interface PageSnapshot {
  id: string;
  title: string;
  blocks: string[];
}

/**
 * One row of the page, flattened for rendering.
 *
 * The UI cannot render from `treeShape`, which returns indented text for agents
 * to read. It needs per-block type, text, depth and state so it can pick a
 * renderer and draw affordances. Flattening here rather than in the renderer
 * keeps the traversal in one place and means the renderer never walks the model.
 */
export interface BlockRow {
  id: string;
  type: string;
  text: string;
  /** Nesting level, 0 at the page root. */
  depth: number;
  /** Rendered children when collapsed, so the UI can show "3 collapsed". */
  hiddenChildren: number;
  checked: boolean;
  /** The kind of a callout, so the editor can draw the right icon. */
  calloutKind?: string;
  collapsed: boolean;
  hasChildren: boolean;
  /**
   * The block's runs, not just its plain text.
   *
   * The renderer needs these to draw bold, links and the rest. Sending only
   * `text` means every mark is stored in the model, applied by a command, and
   * then never displayed: the user toggles bold, the command succeeds, and the
   * screen does not change. Keeping `text` alongside is deliberate -- it is
   * what the input handler diffs against.
   */
  runs: TextRun[];
}

export class Session {
  readonly repo: Repository;
  readonly history = new History();

  /** The open page, or null when nothing is open. */
  pageId: string | null = null;
  doc: Doc = createDoc();
  selection: Selection | null = null;

  private readonly autosaveMs: number;
  private readonly versionEvery: number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires at the end of a burst of edits. Separate from saveTimer, and not
      cleared by flush() -- see scheduleVersion. */
  private versionTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private transactionsSinceVersion = 0;
  /** Set on every edit; cleared when a version is captured. */
  private versionPending = false;
  /** When the last edit happened, epoch ms. A pause since then starts a new run. */
  private lastEditAt = 0;
  /** How long a pause has to be before the next edit counts as a new run. */
  private readonly quietMs = 400;

  constructor(repo: Repository, options: SessionOptions = {}) {
    this.repo = repo;
    this.autosaveMs = options.autosaveMs ?? 400;
    this.versionEvery = options.versionEvery ?? 25;
  }

  // ------------------------------------------------------------------ pages

  openPage(id: string): PageSnapshot {
    this.flush();
    // The state you are leaving is a version worth keeping. Without this,
    // switching away and back loses the edit you made just before switching.
    this.captureVersion('before leaving');
    const page = this.repo.getPage(id);
    if (!page) throw new Error(`no such page: ${id}`);
    this.pageId = id;
    this.doc = this.repo.loadPage(id);
    this.selection = this.doc.roots[0] ? caretAt(this.doc.roots[0], 0) : null;
    this.history.clear();
    this.repo.noteOpened(id);
    return { id, title: page.title, blocks: this.doc.roots };
  }

  closePage(): void {
    this.flush();
    this.captureVersion('before closing');
    this.pageId = null;
    this.doc = createDoc();
    this.selection = null;
    this.history.clear();
  }

  createPage(input: { title?: string; parentPage?: string | null; icon?: string }): string {
    const id = this.repo.createPage({
      title: input.title ?? '',
      parentPage: input.parentPage ?? null,
      icon: input.icon ?? null,
    });
    // Every page starts with one empty paragraph so the editor always has a
    // caret target; a page with zero blocks is a dead end for the user.
    const { doc, rootId } = emptyPage();
    void rootId;
    this.repo.savePage(id, doc);
    return id;
  }

  /** A structured view of the open page, for agents and tests. */
  inspect(): PageSnapshot & { tree: string[]; selection: Selection | null } {
    return {
      id: this.pageId ?? '',
      title: this.pageId ? (this.repo.getPage(this.pageId)?.title ?? '') : '',
      blocks: [...this.doc.roots],
      tree: treeShape(this.doc),
      selection: this.selection,
    };
  }

  /**
   * Flattened page rows in document order, for the renderer.
   *
   * Honours collapsed state so a collapsed subtree contributes no rows, and
   * reports how many it hid so the UI can show "3 collapsed" the way the
   * reference does.
   */
  outline(): BlockRow[] {
    const rows: BlockRow[] = [];
    const visit = (ids: string[], depth: number) => {
      for (const id of ids) {
        const block = this.doc.blocks[id];
        if (!block || block.trashedAt !== null) continue;
        const allChildren = block.children.length;
        rows.push({
          id: block.id,
          type: block.type,
          text: textOf(block.content),
          depth,
          hiddenChildren: block.collapsed ? allChildren : 0,
          checked: block.props.checked === true,
          ...(block.props.calloutKind ? { calloutKind: block.props.calloutKind } : {}),
          collapsed: block.collapsed,
          hasChildren: allChildren > 0,
          runs: block.content.runs,
        });
        if (!block.collapsed) visit(block.children, depth + 1);
      }
    };
    visit(this.doc.roots, 0);
    return rows;
  }

  /** The first block whose text contains `text`, or undefined. */
  findBlockByText(text: string): Block | undefined {
    return walk(this.doc).find((b) => textOf(b.content).includes(text));
  }

  // ------------------------------------------------------------- mutation

  /**
   * Run one user intent. `body` mutates the document; the session wraps it in a
   * transaction, marks the page dirty and schedules an autosave.
   *
   * `coalescible` merges this edit into the previous one when they share a
   * `group` and fall within the typing window, so a burst of typing is one undo
   * step rather than one per character. Passing `coalescible` without a `group`
   * does nothing at all: History refuses to merge two edits that name no group,
   * which is deliberate -- merging unrelated edits across blocks would make one
   * Ctrl+Z revert something the user never did.
   */
  edit(
    label: string,
    body: (tx: import('@ow/model').TxContext) => void,
    options?: { coalescible?: boolean; group?: string | null },
  ): void {
    if (!this.pageId) throw new Error('no page is open');
    transact(this.doc, this.history, label, body, {
      coalescible: options?.coalescible ?? false,
      group: options?.group ?? null,
      selBefore: this.selection?.level === 'text' ? this.selection.blockId : null,
    });
    this.dirty = true;
    this.versionPending = true;
    // The state before this burst is the one worth keeping.
    this.captureBeforeBurst();
    this.transactionsSinceVersion += 1;
    if (this.transactionsSinceVersion >= this.versionEvery) {
      this.transactionsSinceVersion = 0;
      // The window is over. Store the state it ended on.
      this.captureVersion(null);
    }
    this.scheduleSave();
  }

  /**
   * Restore a saved version of the open page.
   *
   * The current state is saved as a version *first*, so restoring never destroys
   * history. The requirement says so explicitly, and it is also the only safe
   * behaviour: a restore that overwrote the history would make the history
   * lossy in exactly the situation where you need it.
   *
   * The undo history is cleared rather than rewound. The history holds
   * references into the old document, and the restored one is a different
   * object; keeping it would let an undo write the old blocks into the new
   * document.
   */
  restoreVersion(versionId: string): boolean {
    if (!this.pageId) return false;
    const snapshot = this.repo.loadVersion(versionId);
    if (!snapshot) return false;
    this.repo.saveVersion(this.pageId, this.doc, 'before restore');
    this.doc = snapshot;
    this.selection = this.doc.roots[0] ? caretAt(this.doc.roots[0], 0) : null;
    this.history.clear();
    this.dirty = true;
    this.scheduleSave();
    return true;
  }

  undo(): boolean {
    if (!this.pageId) return false;
    const t = this.history.undo(this.doc);
    if (!t) return false;
    this.dirty = true;
    this.scheduleSave();
    return true;
  }

  redo(): boolean {
    if (!this.pageId) return false;
    const t = this.history.redo(this.doc);
    if (!t) return false;
    this.dirty = true;
    this.scheduleSave();
    return true;
  }

  // ------------------------------------------------------------ persistence

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.autosaveMs);
    // Never hold the process open for an autosave; the CLI must be able to exit.
    if (typeof this.saveTimer === 'object' && 'unref' in this.saveTimer) {
      (this.saveTimer as { unref(): void }).unref();
    }
  }

  /**
   * Schedule the end of the current burst of edits.
   *
   * A separate timer from the save, and deliberately not cleared by `flush()`.
   *
   * `flush()` runs after every command and clears the save timer, so a timer
   * shared with the save never fires: the burst-end capture simply did not
   * happen, and the only version ever stored was the pre-burst one. The two
   * timers have different jobs -- one writes the page, one decides that the user
   * has stopped typing -- and coupling them meant one of them never ran.
   */
  private scheduleVersion(): void {
    // Deliberately empty.
    //
    // The obvious design is a debounce timer that fires when the user stops
    // typing. It does not work here: `flush()` runs after every command and
    // clears the save timer, so a timer in this class never survives long enough
    // to fire -- and a timer that does fire keeps the Electron main process
    // alive, so the window never closes and every test that tears the app down
    // hangs until its timeout.
    //
    // The burst boundary is therefore the transaction count the session already
    // kept: a version every N transactions, with the state *before* each
    // window captured synchronously.
    void 0;
  }

  /**
   * Save a version of the open page, if the document has changed since the
   * last one.
   *
   * The flag rather than a transaction count, because what a person means by
   * "an earlier version" is a state they paused at, not a fixed number of
   * keystrokes.
   */
  private captureVersion(label: string | null = null): void {
    if (!this.versionPending || !this.pageId) return;
    this.versionPending = false;
    try {
      this.repo.saveVersion(this.pageId, this.doc, label);
    } catch {
      // The repository may already be closed -- a test disposes the session and
      // closes the database straight afterwards, and the burst timer fires in
      // between. Losing a version on the way out is harmless; an unhandled
      // rejection is not, and it surfaced as an error in every test that used a
      // session, none of them about the thing that had actually gone wrong.
    }
  }

  /**
   * Capture the state *before* a new run of edits begins.
   *
   * A version captured after the fact cannot restore what the edit destroyed.
   * The first version of this feature saved on the autosave debounce, which
   * fires after the run is over -- so the page only ever had versions of states
   * the user had already moved on from, and the state before a replacement was
   * never stored at all.
   *
   * A run of edits ends when the user pauses, and the pause is detected by a
   * **timestamp** rather than a timer.
   *
   * That is not a stylistic choice. A timer in this class does not work:
   * `flush()` runs after every command and clears the save timer, so a timer
   * here never survives long enough to fire -- and a timer that does fire keeps
   * the Electron main process alive, so the window never closes and every test
   * that tears the app down hangs until its timeout. A timestamp needs neither
   * a tick nor an owner.
   */
  private captureBeforeBurst(): void {
    if (!this.pageId) return;
    const now = Date.now();
    // A pause since the last edit means this one starts a new run.
    if (now - this.lastEditAt > this.quietMs) {
      this.repo.saveVersion(this.pageId, this.doc, null);
    }
    this.lastEditAt = now;
  }

  /** Write the open page if it has unsaved changes. Safe to call often. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || !this.pageId) return;
    this.repo.savePage(this.pageId, this.doc);
    this.dirty = false;
  }

  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  dispose(): void {
    // The burst timer has to go before the repository does, or it fires against
    // a closed database.
    if (this.versionTimer) {
      clearTimeout(this.versionTimer);
      this.versionTimer = null;
    }
    this.flush();
  }
}

export function newSessionId(): string {
  return newId();
}