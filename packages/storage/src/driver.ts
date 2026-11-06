/**
 * A thin adapter over whichever SQLite binding is available.
 *
 * Two bindings are supported because neither one is available everywhere this
 * code runs:
 *
 *  - `node:sqlite` is built into Node 22.5 and later. It needs no compilation,
 *    so the CLI and the test suite work on a clean machine with no build tools.
 *  - `better-sqlite3` is a native addon. It is faster for large writes and is
 *    the pragmatic choice inside a packaged desktop app, but it needs a
 *    prebuilt binary or a working toolchain.
 *
 * The two expose near-identical `prepare` / `exec` / `close` surfaces, so this
 * file exists only to normalise the handful of differences that matter:
 * parameter binding style, the absence of `Database.prototype.function`, and the
 * fact that `node:sqlite` returns null-prototype rows.
 *
 * No SQL is written in this file. Everything else in the layer assumes `Db`.
 */

import { createRequire } from 'node:module';

export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
  /** True when this binding is the built-in one. */
  readonly driver: 'node:sqlite' | 'better-sqlite3';
  /** Open a second connection to the same file, used by tests. */
  clone(): Db;
  transaction<T>(fn: () => T): T;
}

type Row = Record<string, unknown>;

function asPlain<T>(value: unknown): T {
  if (value === null || typeof value !== 'object') return value as T;
  // node:sqlite returns null-prototype objects; `in` and spread work, but
  // userland code (and some libraries) expects a real prototype.
  return Object.assign({}, value) as T;
}

/** `node:sqlite` wants positional `?` and explicit binding; we use named ones. */
function bindNodeSqlite(stmt: unknown, params: unknown[]): unknown[] {
  // Named parameters in our SQL are written as `:name`, which node:sqlite binds
  // from an object. The helpers in this layer always call with positional args,
  // so callers that use names must pass a single object; detect and pass through.
  void stmt;
  return params.length === 1 && params[0] !== null && typeof params[0] === 'object'
    ? [params[0] as object]
    : params;
}

/**
 * Run `fn` inside a transaction.
 *
 * Re-entrant: nested calls join the outer transaction instead of issuing a
 * second `BEGIN`, which SQLite rejects. Repository methods compose freely --
 * `restorePage` updates the page tree and then rebuilds that page's search rows,
 * and that second step is itself transactional -- so composing is the normal
 * case, not an edge case. Only the outermost call issues `BEGIN`/`COMMIT`.
 *
 * Savepoints are deliberately not used: they would let an inner failure be
 * recovered while still committing the outer transaction, which is a much more
 * confusing failure mode than "the whole thing rolled back".
 */
function makeTransaction(exec: (sql: string) => void): <T>(fn: () => T) => T {
  let depth = 0;
  return function transaction<T>(fn: () => T): T {
    if (depth > 0) {
      depth += 1;
      try {
        return fn();
      } finally {
        depth -= 1;
      }
    }
    exec('BEGIN IMMEDIATE');
    depth = 1;
    try {
      const out = fn();
      depth = 0;
      exec('COMMIT');
      return out;
    } catch (error) {
      depth = 0;
      try {
        exec('ROLLBACK');
      } catch {
        // A rollback failure must not mask the original error.
      }
      throw error;
    }
  };
}

function makeNodeSqlite(db: {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
  };
  close(): void;
  open?: boolean;
  location?: string;
}): Db {
  const wrap = (raw: ReturnType<Db['prepare']> extends never ? never : any): Statement => ({
    run: (...params: unknown[]) => {
      const r = raw.run(...bindNodeSqlite(raw, params));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get: (...params: unknown[]) => {
      const row = raw.get(...bindNodeSqlite(raw, params));
      return row === undefined ? undefined : asPlain(row);
    },
    all: (...params: unknown[]) =>
      raw.all(...bindNodeSqlite(raw, params)).map((r: unknown) => asPlain(r)),
  });

  const api: Db = {
    driver: 'node:sqlite',
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => wrap(db.prepare(sql)),
    close: () => db.close(),
    clone: () => makeNodeSqlite(db as never),
    transaction: makeTransaction((sql) => db.exec(sql)),
  };
  return api;
}

export interface OpenOptions {
  /** Fail instead of creating when the file does not exist. */
  readonly?: boolean;
  /** Create the parent directory if missing. */
  createDirs?: boolean;
}

/**
 * Open a database. Prefers the built-in binding, falls back to the native one.
 *
 * Both bindings are loaded through `createRequire` rather than a dynamic
 * `import()` on purpose. Bundlers rewrite `import('node:sqlite')` into a
 * resolvable specifier, and most of them do not know that prefix, so the
 * bundler tries to resolve a package literally named `sqlite` and fails at
 * runtime with a message that points nowhere useful. `createRequire` performs a
 * real Node resolution at call time, which is what we want for both a builtin
 * and a native addon.
 */
export async function openDatabase(path: string, options: OpenOptions = {}): Promise<Db> {
  if (options.createDirs) await ensureDir(dirnameOf(path));
  const require_ = createRequire(import.meta.url);

  const builtinErrors: string[] = [];
  try {
    const mod = require_('node:sqlite') as {
      DatabaseSync: new (path: string, opts?: { open?: boolean; readOnly?: boolean }) => never;
    };
    const raw = new mod.DatabaseSync(path, { open: true, readOnly: options.readonly ?? false });
    return makeNodeSqlite(raw as never);
  } catch (error) {
    builtinErrors.push(`node:sqlite: ${String(error)}`);
  }

  try {
    const mod = require_('better-sqlite3') as {
      default?: new (path: string, opts?: { readonly?: boolean }) => never;
    };
    const Ctor = mod.default ?? (mod as unknown as new (path: string, opts?: { readonly?: boolean }) => never);
    const raw = new Ctor(path, { readonly: options.readonly ?? false });
    return makeBetterSqlite3(raw as never);
  } catch (error) {
    builtinErrors.push(`better-sqlite3: ${String(error)}`);
  }

  throw new Error(
    'no SQLite binding available. Use Node 22.5 or newer for the built-in ' +
      `driver, or install better-sqlite3. Attempts: ${builtinErrors.join(' | ')}`,
  );
}

function makeBetterSqlite3(raw: {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
  };
  close(): void;
  transaction<T>(fn: () => T): T;
  pragma(source: string): unknown;
}): Db {
  const wrap = (s: ReturnType<Db['prepare']> extends never ? never : any): Statement => ({
    run: (...params: unknown[]) => {
      const r = s.run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get: (...params: unknown[]) => {
      const row = s.get(...params);
      return row === undefined ? undefined : asPlain(row);
    },
    all: (...params: unknown[]) => s.all(...params).map((r: unknown) => asPlain(r)),
  });
  return {
    driver: 'better-sqlite3',
    exec: (sql: string) => {
      raw.exec(sql);
    },
    prepare: (sql: string) => wrap(raw.prepare(sql)),
    close: () => raw.close(),
    clone: () => makeBetterSqlite3(raw as never),
    // better-sqlite3 has its own transaction helper, but routing through the same
    // re-entrant wrapper keeps nesting behaviour identical across both bindings.
    transaction: makeTransaction((sql) => {
      raw.exec(sql);
    }),
  };
}

function dirnameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i <= 0 ? '.' : path.slice(0, i);
}

async function ensureDir(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}