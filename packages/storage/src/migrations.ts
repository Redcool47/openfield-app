/**
 * Schema and forward-only migrations.
 *
 * Rules, in the order they matter:
 *
 * 1. **Forward only.** No down-migrations. A user who skipped three releases
 *    must be able to open the workspace, and a down-migration cannot know what
 *    state the skipped releases would have left behind.
 * 2. **Numbered and never edited.** A migration that has shipped is history.
 *    Changing one silently rewrites the past for users who already ran it. Fix
 *    forward with a new migration instead.
 * 3. **Each migration is one transaction.** A power cut mid-migration leaves the
 *    workspace on the previous schema version, not half-migrated.
 * 4. **Tested against a fixture from every previous version.** `migrationTests`
 *    below is the list the CI check walks.
 *
 * Ordering notes that are easy to get wrong:
 *  - the block table's index on (parent_id, position) is what makes sibling
 *    reads a range scan rather than a sort;
 *  - the FTS5 table is external-content-free on purpose. An external-content
 *    table would save space but makes every write responsible for keeping the
 *    shadow tables in step, and a mismatch produces silently missing search
 *    results that are very hard to trace back.
 */

import type { Db } from './driver.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE IF NOT EXISTS workspace (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL DEFAULT 'Workspace',
        icon        TEXT,
        created_at  INTEGER NOT NULL,
        settings_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS block (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        parent_id   TEXT,
        page_id     TEXT NOT NULL,
        position    TEXT NOT NULL,
        props_json  TEXT NOT NULL DEFAULT '{}',
        content_json TEXT NOT NULL DEFAULT '{"runs":[]}',
        collapsed   INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES block(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS block_siblings ON block(parent_id, position);
      CREATE INDEX IF NOT EXISTS block_page      ON block(page_id, position);
      CREATE INDEX IF NOT EXISTS block_type     ON block(type);

      CREATE TABLE IF NOT EXISTS page (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL DEFAULT '',
        icon         TEXT,
        cover        TEXT,
        full_width   INTEGER NOT NULL DEFAULT 0,
        small_text   INTEGER NOT NULL DEFAULT 0,
        font         TEXT NOT NULL DEFAULT 'sans',
        locked       INTEGER NOT NULL DEFAULT 0,
        is_favorite  INTEGER NOT NULL DEFAULT 0,
        favorite_pos TEXT,
        parent_page  TEXT,
        position     TEXT NOT NULL DEFAULT '',
        trashed_at   INTEGER,
        properties_json TEXT NOT NULL DEFAULT '{}',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        FOREIGN KEY (parent_page) REFERENCES page(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS page_tree    ON page(parent_page, position);
      CREATE INDEX IF NOT EXISTS page_trash   ON page(trashed_at);
      CREATE INDEX IF NOT EXISTS page_updated ON page(updated_at DESC);

      CREATE TABLE IF NOT EXISTS collection (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL DEFAULT '',
        schema_json   TEXT NOT NULL DEFAULT '{"properties":[]}',
        default_view  TEXT,
        parent_page   TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS view (
        id            TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL,
        type          TEXT NOT NULL,
        name          TEXT NOT NULL DEFAULT '',
        config_json   TEXT NOT NULL DEFAULT '{}',
        position      TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        FOREIGN KEY (collection_id) REFERENCES collection(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS view_collection ON view(collection_id, position);

      CREATE TABLE IF NOT EXISTS property_value (
        page_id      TEXT NOT NULL,
        property_id  TEXT NOT NULL,
        value_json   TEXT,
        PRIMARY KEY (page_id, property_id)
      );
      CREATE INDEX IF NOT EXISTS property_value_prop ON property_value(property_id);

      CREATE TABLE IF NOT EXISTS relation_edge (
        from_page   TEXT NOT NULL,
        property_id TEXT NOT NULL,
        to_page     TEXT NOT NULL,
        position    TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (from_page, property_id, to_page)
      );
      CREATE INDEX IF NOT EXISTS relation_in  ON relation_edge(from_page, property_id);
      CREATE INDEX IF NOT EXISTS relation_out ON relation_edge(to_page, property_id);

      CREATE TABLE IF NOT EXISTS comment (
        id          TEXT PRIMARY KEY,
        page_id     TEXT NOT NULL,
        block_id    TEXT,
        thread_id   TEXT NOT NULL,
        parent_id   TEXT,
        body_json   TEXT NOT NULL,
        resolved_at INTEGER,
        author      TEXT NOT NULL DEFAULT 'me',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS comment_page ON comment(page_id, created_at);

      CREATE TABLE IF NOT EXISTS page_version (
        id         TEXT PRIMARY KEY,
        page_id    TEXT NOT NULL,
        snapshot   BLOB NOT NULL,
        label      TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS page_version_page ON page_version(page_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS asset (
        sha256        TEXT PRIMARY KEY,
        mime          TEXT NOT NULL,
        size          INTEGER NOT NULL,
        original_name TEXT,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS op_log (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id   TEXT NOT NULL,
        lamport     INTEGER NOT NULL,
        page_id     TEXT NOT NULL,
        op_json     TEXT NOT NULL,
        applied_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS op_log_page ON op_log(page_id, seq);

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_block USING fts5(
        page_id UNINDEXED,
        block_id UNINDEXED,
        title,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS recent (
        page_id   TEXT PRIMARY KEY,
        opened_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS setting (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'markdown-file-mirror',
    sql: `
      -- Where a page's Markdown file lives, and what it contained last time.
      --
      -- The file is the interchange format: it is what another editor writes,
      -- what a file-sync tool carries between machines, and what a person can
      -- open in anything. The hash is how the app tells "changed on disk since
      -- we wrote it" from "we wrote it ourselves" without trusting timestamps,
      -- which are not comparable across a sync tool's clock.
      ALTER TABLE page ADD COLUMN file_path TEXT;
      ALTER TABLE page ADD COLUMN file_hash TEXT;
    `,
  },
];

export const CURRENT_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Schema versions we keep a fixture for. The CI migration check walks this. */
export const migrationTests: number[] = [1];

function readVersion(db: Db): number {
  const has = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`)
    .get();
  if (!has) return 0;
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value?: string }
    | undefined;
  return row?.value ? Number(row.value) : 0;
}

/**
 * Apply every migration newer than the recorded version.
 *
 * `PRAGMA foreign_keys` is left off deliberately: the block tree is the
 * authoritative structure and the application repairs orphans explicitly in
 * `selfTest`, which produces far better diagnostics than a foreign-key failure
 * halfway through a paste.
 */
export function migrate(db: Db): { from: number; to: number; applied: number[] } {
  const from = readVersion(db);
  const applied: number[] = [];
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = OFF');
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
        String(migration.version),
      );
    });
    applied.push(migration.version);
  }
  return { from, to: readVersion(db), applied };
}

export function schemaVersion(db: Db): number {
  return readVersion(db);
}