/**
 * The persistence repository.
 *
 * Design decisions worth stating:
 *
 *  - **One page is one document, stored per page.** The block table is keyed by
 *    page, so opening a page loads exactly that page's rows. Loading a workspace
 *    means listing the `page` table, not every block.
 *
 *  - **A save replaces that page's block rows inside one transaction.** Not a
 *    diff: computing a diff here would buy nothing on a page of a few thousand
 *    blocks and would make "did the write actually land?" much harder to answer.
 *    The op log and page versions carry the history that a diff would have
 *    provided.
 *
 *  - **FTS rows are rewritten with the page.** Same transaction, same
 *    guarantee. A search index that can drift from the data is worse than no
 *    search index, because it looks like it works.
 *
 *  - **Writes are synchronous and short.** The Electron main process owns this
 *    connection. Typing never waits on it: the renderer sends a transaction when
 *    the autosave debounce fires, and a crash between debounces loses at most the
 *    last debounce interval.
 */

import { newId } from '@ow/geom';
import { dirname, join } from 'node:path';
import type { Block, BlockProps, Content, Doc } from '@ow/model';
import { textOf } from '@ow/model';
import type { Db } from './driver.js';
import { Databases } from './databases.js';
import { migrate, schemaVersion } from './migrations.js';

export interface PageRow {
  id: string;
  title: string;
  icon: string | null;
  cover: string | null;
  full_width: number;
  small_text: number;
  font: string;
  locked: number;
  is_favorite: number;
  favorite_pos: string | null;
  parent_page: string | null;
  position: string;
  trashed_at: number | null;
  properties_json: string;
  created_at: number;
  updated_at: number;
}

export interface PageSummary {
  id: string;
  title: string;
  icon: string | null;
  parentPage: string | null;
  position: string;
  trashedAt: number | null;
  isFavorite: boolean;
  hasChildren: boolean;
  updatedAt: number;
}

export interface SearchHit {
  pageId: string;
  title: string;
  snippet: string;
  score: number;
  kind: 'title' | 'body';
}

export interface RepositoryOpenOptions {
  /** Apply pending migrations on open. Default true. */
  migrate?: boolean;
}

export class Repository {
  readonly db: Db;
  /** Databases, views and property values. Exposed rather than forwarded so that
   * commands talk to the same handle the rest of the repository uses. */
  readonly databases: Databases;

  /**
   * Where the database file lives.
   *
   * Written out rather than as a constructor parameter property, because the
   * CLI runs this TypeScript source directly and Node's type stripping does
   * not support parameter properties.
   */
  private readonly path: string;

  private constructor(db: Db, path: string) {
    this.db = db;
    this.path = path;
    this.databases = new Databases(db);
  }

  static async open(path: string, options: RepositoryOpenOptions = {}): Promise<Repository> {
    const { openDatabase } = await import('./driver.js');
    const db = await openDatabase(path, { createDirs: true });
    if (options.migrate !== false) migrate(db);
    return new Repository(db, path);
  }

  /** In-memory instance for tests. */
  static async memory(): Promise<Repository> {
    const { openDatabase } = await import('./driver.js');
    const db = await openDatabase(':memory:');
    migrate(db);
    return new Repository(db, ':memory:');
  }

  /**
   * Where the database file lives.
   *
   * The notes folder defaults beside it, so a workspace that has never been
   * pointed at a synced folder still writes Markdown somewhere sensible.
   */
  get location(): string {
    return this.path;
  }

  /** The folder the notes are written to, whether or not one has been chosen. */
  get defaultNotesRoot(): string {
    return join(dirname(this.path), 'notes');
  }

  close(): void {
    this.db.close();
  }

  version(): number {
    return schemaVersion(this.db);
  }

  // ---------------------------------------------------------------- workspace

  ensureWorkspace(id: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO workspace (id, name, created_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(id, name, Date.now());
  }

  /**
   * Forget a page's recency.
   *
   * Called when a page is trashed. Leaving it in the list would show a row that
   * opens onto an empty page in the bin, which reads as a broken link.
   */
  forgetRecent(pageId: string): void {
    this.db.prepare('DELETE FROM recent WHERE page_id = ?').run(pageId);
  }

  /**
   * Append one operation to the sync log.
   *
   * Append only, and that is the entire contract: nothing here updates a row and
   * nothing here deletes one. A future sync that trusts this log can only be
   * correct if the prefix of the log never changes -- so undo must append its
   * inverse rather than truncate, and a correction must be a new op rather than
   * an edit. The table was declared in the first migration and never written to;
   * this is the writer.
   *
   * `lamport` is read from the current maximum rather than passed in, because a
   * caller-supplied clock is a clock that can go backwards. Ordering here is
   * what a future merge would order on, and a log that can reorder itself is
   * worse than no log.
   */
  appendOp(pageId: string, op: unknown): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(lamport), 0) AS m FROM op_log').get() as { m: number };
    const lamport = row.m + 1;
    this.db
      .prepare(
        `INSERT INTO op_log (device_id, lamport, page_id, op_json, applied_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(this.deviceId(), lamport, pageId, JSON.stringify(op ?? null), Date.now());
    return lamport;
  }

  /** Every logged operation, oldest first. */
  ops(pageId?: string): { seq: number; deviceId: string; lamport: number; pageId: string; op: unknown; appliedAt: number }[] {
    const rows = (
      pageId
        ? this.db.prepare('SELECT * FROM op_log WHERE page_id = ? ORDER BY seq').all(pageId)
        : this.db.prepare('SELECT * FROM op_log ORDER BY seq').all()
    ) as {
      seq: number;
      device_id: string;
      lamport: number;
      page_id: string;
      op_json: string;
      applied_at: number;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      deviceId: r.device_id,
      lamport: r.lamport,
      pageId: r.page_id,
      op: JSON.parse(r.op_json) as unknown,
      appliedAt: r.applied_at,
    }));
  }

  /**
   * This installation's id, stable across sessions.
   *
   * Stored rather than generated per run: an id that changed on every launch
   * would make every op look like it came from a different device, which is
   * exactly the question a sync has to answer first.
   */
  deviceId(): string {
    const existing = this.getSetting<string>('deviceId', '');
    if (existing) return existing;
    const id = newId();
    this.setSetting('deviceId', id);
    return id;
  }

  /**
   * The workspace's people directory.
   *
   * Local people, not accounts: there are no accounts, so a "person" is a name
   * the owner typed. Stored as a setting rather than a table because it is a
   * small, flat list that nothing joins against.
   */
  people(): { id: string; name: string }[] {
    const raw = this.getSetting<unknown>('people', []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is { id: string; name: string } =>
        typeof p === 'object' && p !== null && typeof (p as { id?: unknown }).id === 'string',
    );
  }

  setPeople(people: { id: string; name: string }[]): void {
    this.setSetting('people', people);
  }
  /**
   * Where a page's Markdown file lives, and what it contained last time.
   *
   * The hash is what tells "changed on disk since we wrote it" from "we wrote
   * it ourselves". Timestamps cannot: two machines have two clocks, and a
   * file-sync tool does not preserve them.
   */
  setPageFile(pageId: string, path: string, hash: string): void {
    this.db
      .prepare('UPDATE page SET file_path = ?, file_hash = ? WHERE id = ?')
      .run(path, hash, pageId);
  }

  getPageFileHash(pageId: string): string | undefined {
    const row = this.db.prepare('SELECT file_hash FROM page WHERE id = ?').get(pageId) as
      | { file_hash?: string | null }
      | undefined;
    return row?.file_hash ?? undefined;
  }

  getPageFilePath(pageId: string): string | undefined {
    const row = this.db.prepare('SELECT file_path FROM page WHERE id = ?').get(pageId) as
      | { file_path?: string | null }
      | undefined;
    return row?.file_path ?? undefined;
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM setting WHERE key = ?').get(key) as
      | { value_json?: string }
      | undefined;
    if (!row?.value_json) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO setting (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  // -------------------------------------------------------------------- pages

  createPage(input: {
    id?: string;
    title?: string;
    parentPage?: string | null;
    position?: string;
    icon?: string | null;
  }): string {
    const now = Date.now();
    const id = input.id ?? newId(now);
    const position = input.position ?? this.nextPosition(input.parentPage ?? null);
    this.db
      .prepare(
        `INSERT INTO page (id, title, icon, parent_page, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.title ?? '', input.icon ?? null, input.parentPage ?? null, position, now, now);
    return id;
  }

  private nextPosition(parentPage: string | null): string {
    const row = this.db
      .prepare('SELECT position FROM page WHERE parent_page IS ? AND trashed_at IS NULL ORDER BY position DESC LIMIT 1')
      .get(parentPage) as { position?: string } | undefined;
    if (!row?.position) return 'V';
    // Cheap append: bump the last character. Collisions are resolved by the
    // unique index below, and the caller retries with a longer key.
    const key = row.position;
    const next = key.slice(0, -1) + String.fromCharCode(key.charCodeAt(key.length - 1) + 1);
    return next === key ? `${key}1` : next;
  }

  getPage(id: string): PageRow | undefined {
    return this.db.prepare('SELECT * FROM page WHERE id = ?').get(id) as PageRow | undefined;
  }

  /** Every page directly under `parentPage`, in order. */
  /**
   * The page with this title, matched without regard to case.
   *
   * A wiki link names a page by its title, and titles are not unique -- two
   * pages can be called Notes. The first match wins, and that is the same
   * answer the mention picker gives.
   */
  findPageByTitle(title: string): PageRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM page WHERE title = ? COLLATE NOCASE AND trashed_at IS NULL LIMIT 1',
      )
      .get(title) as PageRow | undefined;
  }

  childPages(parentPage: string | null): PageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, EXISTS(SELECT 1 FROM page c WHERE c.parent_page = p.id AND c.trashed_at IS NULL) AS has_children
         FROM page p
         WHERE p.parent_page IS ? AND p.trashed_at IS NULL
         ORDER BY p.position`,
      )
      .all(parentPage) as PageRowRaw[];
    return rows.map(toSummary);
  }

  allPages(): PageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, EXISTS(SELECT 1 FROM page c WHERE c.parent_page = p.id AND c.trashed_at IS NULL) AS has_children
         FROM page p WHERE p.trashed_at IS NULL ORDER BY p.position`,
      )
      .all() as PageRowRaw[];
    return rows.map(toSummary);
  }

  favoritePages(): PageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, EXISTS(SELECT 1 FROM page c WHERE c.parent_page = p.id AND c.trashed_at IS NULL) AS has_children
         FROM page p WHERE p.is_favorite = 1 AND p.trashed_at IS NULL ORDER BY p.favorite_pos`,
      )
      .all() as PageRowRaw[];
    return rows.map(toSummary);
  }

  trashedPages(): PageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, 0 AS has_children FROM page p WHERE p.trashed_at IS NOT NULL
         ORDER BY p.trashed_at DESC`,
      )
      .all() as PageRowRaw[];
    return rows.map(toSummary);
  }

  renamePage(id: string, title: string): void {
    this.db.prepare('UPDATE page SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id);
  }

  setPageProp<K extends keyof PageRow>(id: string, key: K, value: PageRow[K]): void {
    this.db.prepare(`UPDATE page SET ${String(key)} = ?, updated_at = ? WHERE id = ?`).run(
      value as never,
      Date.now(),
      id,
    );
  }

  /**
   * Move a page to the trash. The subtree is flagged, not deleted, so the page
   * can be restored to its original position in the tree.
   */
  trashPage(id: string): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM page WHERE id = ?
             UNION ALL
             SELECT p.id FROM page p JOIN sub ON p.parent_page = sub.id
           )
           UPDATE page SET trashed_at = ? WHERE id IN (SELECT id FROM sub)`,
        )
        .run(id, now);
      this.db.prepare('DELETE FROM fts_block WHERE page_id IN (SELECT id FROM page WHERE trashed_at = ?)').run(now);
      // Drop recency for the whole subtree. A trashed page stays in the recent
      // table otherwise, and the row still resolves -- so a Recents list would
      // offer a destination that opens onto an empty page in the bin, which
      // reads as a broken link rather than as something that was deleted.
      this.db
        .prepare(
          `DELETE FROM recent WHERE page_id IN (
             WITH RECURSIVE sub(id) AS (
               SELECT id FROM page WHERE id = ?
               UNION ALL
               SELECT p.id FROM page p JOIN sub ON p.parent_page = sub.id
             ) SELECT id FROM sub)`,
        )
        .run(id);
    });
  }

  restorePage(id: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM page WHERE id = ?
             UNION ALL
             SELECT p.id FROM page p JOIN sub ON p.parent_page = sub.id
           )
           UPDATE page SET trashed_at = NULL WHERE id IN (SELECT id FROM sub)`,
        )
        .run(id);
      this.reindexPage(id);
    });
  }

  /** Delete a page and its whole subtree for good. */
  purgePage(id: string): void {
    this.db.transaction(() => {
      const ids = this.db
        .prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM page WHERE id = ?
             UNION ALL
             SELECT p.id FROM page p JOIN sub ON p.parent_page = sub.id
           ) SELECT id FROM sub`,
        )
        .all(id) as { id: string }[];
      for (const { id: pageId } of ids) {
        this.db.prepare('DELETE FROM block WHERE page_id = ?').run(pageId);
        this.db.prepare('DELETE FROM fts_block WHERE page_id = ?').run(pageId);
        this.db.prepare('DELETE FROM page_version WHERE page_id = ?').run(pageId);
        this.db.prepare('DELETE FROM property_value WHERE page_id = ?').run(pageId);
        this.db.prepare('DELETE FROM recent WHERE page_id = ?').run(pageId);
        this.db.prepare('DELETE FROM comment WHERE page_id = ?').run(pageId);
      }
      // Delete every page in the subtree, not just the root. Trashing a tree and
      // then purging it previously left the descendants behind, which then
      // resurfaced as orphaned top-level pages after a restart.
      this.db
        .prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM page WHERE id = ?
             UNION ALL
             SELECT p.id FROM page p JOIN sub ON p.parent_page = sub.id
           ) DELETE FROM page WHERE id IN (SELECT id FROM sub)`,
        )
        .run(id);
    });
  }

  movePage(id: string, newParent: string | null): void {
    if (newParent === id) throw new Error('cannot move a page into itself');
    if (newParent !== null && this.isDescendant(id, newParent)) {
      throw new Error('cannot move a page into its own subtree');
    }
    this.db
      .prepare('UPDATE page SET parent_page = ?, position = ?, updated_at = ? WHERE id = ?')
      .run(newParent, this.nextPosition(newParent), Date.now(), id);
  }

  /**
   * Move a page one place up or down among its siblings.
   *
   * Swapping two entries is not enough on its own: the stored `position` is what
   * orders siblings, and two pages sharing one would make the order depend on the
   * database's whim. So the whole sibling list is renumbered in the same
   * transaction, which also means a move cannot leave a half-written order behind.
   *
   * A no-op at the ends rather than an error: holding Alt+Down should stop, the
   * way the selection stops at the last row.
   */
  reorderPage(id: string, direction: -1 | 1): boolean {
    const row = this.db.prepare('SELECT parent_page FROM page WHERE id = ?').get(id) as
      | { parent_page?: string | null }
      | undefined;
    if (!row) throw new Error(`no such page: ${id}`);
    const parent = row.parent_page ?? null;
    const siblings = (
      this.db
        .prepare(
          'SELECT id FROM page WHERE parent_page IS ? AND trashed_at IS NULL ORDER BY position',
        )
        .all(parent) as { id: string }[]
    ).map((r) => r.id);
    const at = siblings.indexOf(id);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= siblings.length) return false;

    const swapped = [...siblings];
    const moved = swapped[at]!;
    swapped[at] = swapped[to]!;
    swapped[to] = moved;

    this.db.transaction(() => {
      const update = this.db.prepare('UPDATE page SET position = ? WHERE id = ?');
      // Zero-padded so lexical order matches numeric order, which the sidebar's
      // `ORDER BY position` relies on.
      swapped.forEach((pageId, index) => update.run(String(index).padStart(6, '0'), pageId));
    });
    return true;
  }

  /**
   * Update a page's presentation fields.
   *
   * A patch rather than four setters because the columns travel together and a
   * caller changing the font should not have to remember to re-send the rest.
   * `undefined` means "leave alone"; `null` clears.
   */
  setPageAppearance(
    id: string,
    patch: { cover?: string | null; fullWidth?: boolean; smallText?: boolean; font?: string },
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.cover !== undefined) {
      sets.push('cover = ?');
      values.push(patch.cover);
    }
    if (patch.fullWidth !== undefined) {
      sets.push('full_width = ?');
      values.push(patch.fullWidth ? 1 : 0);
    }
    if (patch.smallText !== undefined) {
      sets.push('small_text = ?');
      values.push(patch.smallText ? 1 : 0);
    }
    if (patch.font !== undefined) {
      sets.push('font = ?');
      values.push(patch.font);
    }
    if (sets.length === 0) return;
    this.db
      .prepare(`UPDATE page SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...(values as never[]), Date.now(), id);
  }

  private isDescendant(ancestor: string, maybeChild: string): boolean {
    let cur: string | null = maybeChild;
    for (let i = 0; i < 10_000 && cur; i += 1) {
      if (cur === ancestor) return true;
      const row = this.db.prepare('SELECT parent_page FROM page WHERE id = ?').get(cur) as
        | { parent_page?: string | null }
        | undefined;
      cur = row?.parent_page ?? null;
    }
    return false;
  }

  toggleFavorite(id: string, favorite: boolean): void {
    const pos = favorite ? `f${Date.now().toString(36)}` : null;
    this.db.prepare('UPDATE page SET is_favorite = ?, favorite_pos = ? WHERE id = ?').run(favorite ? 1 : 0, pos, id);
  }

  // ------------------------------------------------------------------- blocks

  /**
   * Replace a page's blocks and rebuild its search rows, atomically.
   *
   * `doc.roots` defines sibling order; the fractional `position` column is
   * rewritten in the same pass so the two can never disagree after a reload.
   */
  savePage(pageId: string, doc: Doc): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM block WHERE page_id = ?').run(pageId);
      this.db.prepare('DELETE FROM fts_block WHERE page_id = ?').run(pageId);

      const insert = this.db.prepare(
        `INSERT INTO block (id, type, parent_id, page_id, position, props_json, content_json,
                            collapsed, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const bodyParts: string[] = [];
      const insertBlock = (id: string) => {
        const b: Block = doc.blocks[id]!;
        insert.run(
          b.id,
          b.type,
          b.parentId,
          pageId,
          b.position,
          JSON.stringify(b.props),
          JSON.stringify(b.content),
          b.collapsed ? 1 : 0,
          null,
          b.createdAt,
          b.updatedAt,
        );
        bodyParts.push(textOf(b.content));
        for (const child of b.children) insertBlock(child);
      };
      for (const root of doc.roots) insertBlock(root);

      const pageTitle = this.db.prepare('SELECT title FROM page WHERE id = ?').get(pageId) as
        | { title?: string }
        | undefined;
      this.db
        .prepare('INSERT INTO fts_block (page_id, block_id, title, body) VALUES (?, ?, ?, ?)')
        .run(pageId, pageId, pageTitle?.title ?? '', bodyParts.join('\n'));

      this.db.prepare('UPDATE page SET updated_at = ? WHERE id = ?').run(now, pageId);
    });
  }

  /** Load a page's blocks into a document. */
  loadPage(pageId: string): Doc {
    const rows = this.db
      .prepare('SELECT * FROM block WHERE page_id = ? ORDER BY position')
      .all(pageId) as BlockRow[];
    const doc: Doc = { blocks: {}, roots: [] };
    for (const row of rows) {
      doc.blocks[row.id] = {
        id: row.id,
        type: row.type,
        parentId: row.parent_id,
        position: row.position,
        content: safeJson<Content>(row.content_json, { runs: [] }),
        props: safeJson<BlockProps>(row.props_json, {}),
        children: [],
        collapsed: row.collapsed === 1,
        trashedAt: null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
    // Second pass for children, so ordering within a parent is by position.
    const byParent = new Map<string | null, BlockRow[]>();
    for (const row of rows) {
      const list = byParent.get(row.parent_id) ?? [];
      list.push(row);
      byParent.set(row.parent_id, list);
    }
    for (const [parent, list] of byParent) {
      list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
      const target = parent === null ? doc.roots : doc.blocks[parent]?.children;
      if (!target) continue;
      for (const row of list) target.push(row.id);
    }
    return doc;
  }

  /**
   * Rebuild the search index rows for one page from its stored blocks.
   * Called after a restore, because trashing a page also removes its rows.
   */
  reindexPage(pageId: string): void {
    const rows = this.db
      .prepare('SELECT id, content_json FROM block WHERE page_id = ? ORDER BY position')
      .all(pageId) as { id: string; content_json: string }[];
    const pageTitle =
      (this.db.prepare('SELECT title FROM page WHERE id = ?').get(pageId) as { title?: string } | undefined)
        ?.title ?? '';
    const body = rows.map((r) => textOf(safeJson<Content>(r.content_json, { runs: [] }))).join('\n');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM fts_block WHERE page_id = ?').run(pageId);
      this.db
        .prepare('INSERT INTO fts_block (page_id, block_id, title, body) VALUES (?, ?, ?, ?)')
        .run(pageId, pageId, pageTitle, body);
    });
  }

  // ------------------------------------------------------------------ search

  /**
   * Quick find.
   *
   * Ranking, highest first: an exact title match, then a title prefix, then a
   * title substring, then a body match. Recently opened pages break ties.
   *
   * The query is passed to FTS5 as a quoted prefix term rather than raw user
   * input. That is both correct (a user typing `a-b` should not produce a
   * syntax error) and safe (no FTS5 operator is ever interpreted).
   */
  search(query: string, limit = 20): SearchHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const match = `"${trimmed.replace(/"/g, '""')}"*`;
    // The FTS5 table is deliberately not aliased here: `snippet` and `bm25`
    // take the table *name* as their first argument, and SQLite rejects an alias
    // with "no such column". Qualifying the page columns instead avoids the
    // alias entirely.
    const rows = this.db
      .prepare(
        `SELECT fts_block.page_id AS page_id, page.title AS title,
                snippet(fts_block, 3, '\u2039', '\u203a', ' \u2026 ', 12) AS snip,
                bm25(fts_block, 10.0, 1.0) AS rank
         FROM fts_block
         JOIN page ON page.id = fts_block.page_id
         WHERE fts_block MATCH ? AND page.trashed_at IS NULL
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit * 3) as {
      page_id: string;
      title: string;
      snip: string;
      rank: number;
    }[];

    const now = Date.now();
    const recents = new Map<string, number>(
      (
        this.db.prepare('SELECT page_id, opened_at FROM recent ORDER BY opened_at DESC').all() as {
          page_id: string;
          opened_at: number;
        }[]
      ).map((r) => [r.page_id, r.opened_at]),
    );

    const hits: SearchHit[] = rows.map((r) => {
      const lower = r.title.toLowerCase();
      const t = trimmed.toLowerCase();
      const inTitle = lower.includes(t);
      let score = inTitle ? -r.rank / 100 : -r.rank / 400;
      if (lower === t) score += 1000;
      else if (lower.startsWith(t)) score += 500;
      const opened = recents.get(r.page_id);
      if (opened !== undefined) {
        // Linear decay over a week: recent matters, ancient barely counts.
        score += 50 * Math.max(0, 1 - (now - opened) / (7 * 24 * 3600 * 1000));
      }
      return {
        pageId: r.page_id,
        title: r.title,
        snippet: r.snip,
        score,
        kind: inTitle ? 'title' : 'body',
      };
    });

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  noteOpened(pageId: string): void {
    this.db
      .prepare(
        `INSERT INTO recent (page_id, opened_at) VALUES (?, ?)
         ON CONFLICT(page_id) DO UPDATE SET opened_at = excluded.opened_at`,
      )
      .run(pageId, Date.now());
  }

  /**
   * Pages that mention this one.
   *
   * A mention is an inline node inside a block's content, so the backlink
   * index is the block content itself. The SQL narrows the scan with a LIKE on
   * the id and the rows are then parsed and checked properly -- a LIKE match on
   * its own would report a page that merely contains the same characters
   * somewhere in its text.
   */
  backlinks(pageId: string): { pageId: string; title: string; snippet: string }[] {
    if (!pageId) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT p.id AS page_id, p.title AS title, b.content_json AS content_json
         FROM block b JOIN page p ON p.id = b.page_id
         WHERE b.content_json LIKE ? AND p.trashed_at IS NULL AND b.page_id != ?`,
      )
      .all(`%"kind":"page","pageId":"${pageId}"%`, pageId) as {
      page_id: string;
      title: string;
      content_json: string;
    }[];

    const out: { pageId: string; title: string; snippet: string }[] = [];
    for (const row of rows) {
      let runs: { text?: string; inline?: { kind?: string; pageId?: string } }[] = [];
      try {
        const parsed = JSON.parse(row.content_json) as { runs?: typeof runs };
        runs = parsed.runs ?? [];
      } catch {
        // A block whose content will not parse is not a backlink.
        continue;
      }
      const mentioned = runs.some((r) => r.inline?.kind === 'page' && r.inline.pageId === pageId);
      if (!mentioned) continue;
      out.push({
        pageId: row.page_id,
        title: row.title,
        snippet: runs.map((r) => r.text ?? '').join('').slice(0, 140),
      });
    }
    return out;
  }

  /**
   * Lock or unlock a page.
   *
   * A locked page is read-only: the editor refuses edits and the header shows a
   * small lock. The column has been in the schema since the first migration with
   * nothing writing to it, which is a schema that is not a feature.
   */
  setPageLocked(pageId: string, locked: boolean): void {
    if (!this.getPage(pageId)) throw new Error(`no such page: ${pageId}`);
    this.db
      .prepare('UPDATE page SET locked = ?, updated_at = ? WHERE id = ?')
      .run(locked ? 1 : 0, Date.now(), pageId);
  }

  recentPages(limit = 10): PageSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, 0 AS has_children FROM recent r JOIN page p ON p.id = r.page_id
         WHERE p.trashed_at IS NULL ORDER BY r.opened_at DESC LIMIT ?`,
      )
      .all(limit) as PageRowRaw[];
    return rows.map(toSummary);
  }

  // ----------------------------------------------------------------- history

  /** Snapshot a page for the history panel. */
  saveVersion(pageId: string, doc: Doc, label: string | null): string {
    const id = newId();
    const snapshot = JSON.stringify(doc);
    this.db
      .prepare('INSERT INTO page_version (id, page_id, snapshot, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, pageId, Buffer.from(snapshot, 'utf8'), label, Date.now());
    return id;
  }

  listVersions(pageId: string): { id: string; label: string | null; createdAt: number; size: number }[] {
    // `created_at` is millisecond resolution, and a burst of autosaves routinely
    // lands several versions inside the same millisecond. Ordering on the
    // timestamp alone is then arbitrary, which shows up as the history panel
    // listing versions in the wrong order with no obvious cause. The rowid
    // tiebreak restores insertion order.
    const rows = this.db
      .prepare(
        `SELECT id, label, created_at, length(snapshot) AS size FROM page_version
         WHERE page_id = ? ORDER BY created_at DESC, rowid DESC`,
      )
      .all(pageId) as { id: string; label: string | null; created_at: number; size: number }[];
    return rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, size: r.size }));
  }

  loadVersion(versionId: string): Doc | undefined {
    const row = this.db.prepare('SELECT snapshot FROM page_version WHERE id = ?').get(versionId) as
      | { snapshot?: Uint8Array | null }
      | undefined;
    if (!row?.snapshot) return undefined;
    return JSON.parse(Buffer.from(row.snapshot).toString('utf8')) as Doc;
  }

  // -------------------------------------------------------------- crash check

  /**
   * Integrity self-test, run at startup.
   *
   * Checks the three things that actually go wrong in practice: a block whose
   * parent row is missing, a child id listed twice, and search rows whose block
   * no longer exists. Repairs what is safe to repair and reports the rest rather
   * than throwing, because refusing to open a user's workspace over an
   * inconsistent index would be worse than the inconsistency.
   */
  selfTest(): { ok: boolean; repaired: string[]; problems: string[] } {
    const repaired: string[] = [];
    const problems: string[] = [];

    // Orphaned blocks: parent_id points at a row that is gone.
    const orphans = this.db
      .prepare(
        `SELECT b.id FROM block b
         LEFT JOIN block p ON p.id = b.parent_id
         WHERE b.parent_id IS NOT NULL AND p.id IS NULL`,
      )
      .all() as { id: string }[];
    if (orphans.length) {
      this.db.transaction(() => {
        for (const o of orphans) {
          this.db.prepare('UPDATE block SET parent_id = NULL WHERE id = ?').run(o.id);
        }
      });
      repaired.push(`reparented ${orphans.length} orphaned block(s) to the page root`);
    }

    // Search rows with no page.
    const stray = this.db
      .prepare('SELECT page_id FROM fts_block WHERE page_id NOT IN (SELECT id FROM page)')
      .all() as { page_id: string }[];
    if (stray.length) {
      this.db.transaction(() => {
        for (const s of stray) this.db.prepare('DELETE FROM fts_block WHERE page_id = ?').run(s.page_id);
      });
      repaired.push(`removed ${stray.length} orphaned search row(s)`);
    }

    const integrity = this.db.prepare('PRAGMA integrity_check').get() as
      | { integrity_check?: string }
      | undefined;
    if (integrity?.integrity_check && integrity.integrity_check !== 'ok') {
      problems.push(`sqlite integrity_check: ${integrity.integrity_check}`);
    }

    return { ok: problems.length === 0, repaired, problems };
  }

  stats(): { pages: number; blocks: number; ftsRows: number; dbBytes: number } {
    const count = (sql: string) =>
      Number((this.db.prepare(sql).get() as { n?: number } | undefined)?.n ?? 0);
    return {
      pages: count('SELECT COUNT(*) AS n FROM page WHERE trashed_at IS NULL'),
      blocks: count('SELECT COUNT(*) AS n FROM block'),
      ftsRows: count('SELECT COUNT(*) AS n FROM fts_block'),
      dbBytes: count('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()'),
    };
  }
}

interface BlockRow {
  id: string;
  type: string;
  parent_id: string | null;
  page_id: string;
  position: string;
  props_json: string;
  content_json: string;
  collapsed: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * A page row exactly as SQLite returns it: snake_case columns plus the computed
 * `has_children` flag. Kept separate from `PageSummary` because the rest of this
 * layer speaks camelCase to callers, and the conversion happens once, in
 * `toSummary`, rather than leaking raw column names through every method.
 */
interface PageRowRaw {
  id: string;
  title: string;
  icon: string | null;
  cover: string | null;
  full_width: number;
  small_text: number;
  font: string;
  locked: number;
  is_favorite: number;
  favorite_pos: string | null;
  parent_page: string | null;
  position: string;
  trashed_at: number | null;
  properties_json: string;
  created_at: number;
  updated_at: number;
  has_children?: number;
}

function toSummary(row: PageRowRaw): PageSummary {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon ?? null,
    parentPage: row.parent_page ?? null,
    position: row.position,
    trashedAt: row.trashed_at ?? null,
    isFavorite: row.is_favorite === 1,
    hasChildren: Number(row.has_children ?? 0) === 1,
    updatedAt: row.updated_at ?? 0,
  };
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}