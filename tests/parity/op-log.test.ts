/**
 * The append-only op log.
 *
 * The table has existed since the first migration and nothing ever wrote to it.
 * These tests are mostly about what the log must NOT do, because that is the
 * property a future sync depends on and the one that is easy to break by
 * accident:
 *
 *   - nothing rewrites an existing row,
 *   - nothing deletes,
 *   - undo appends its inverse rather than truncating the log,
 *   - ordering cannot go backwards.
 *
 * The strongest assertion here is the prefix check: snapshot the whole log,
 * do more work, then assert every earlier row is byte-identical. That catches an
 * update to history that "the row count went up" would not.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Repository } from '@ow/storage';
import { Session, createRegistry, runCommand } from '@ow/commands';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let repo: Repository;
let session: Session;
let registry: ReturnType<typeof createRegistry>;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ow-oplog-'));
  repo = await Repository.open(join(dir, 'w.sqlite'));
  repo.ensureWorkspace('default', 'W');
  session = new Session(repo, { autosaveMs: 0 });
  registry = createRegistry();
});

afterEach(async () => {
  session.dispose();
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

const run = (id: string, args: Record<string, unknown> = {}) =>
  runCommand(id, args, { session, registry, soft: true });

/** A page with one block, open and ready. */
async function seeded(): Promise<string> {
  const page = (await run('page.create', { title: 'Log' })).value as { id: string };
  await run('page.open', { id: page.id });
  await run('block.insert', { type: 'paragraph', text: 'hello' });
  return page.id;
}

describe('append-only op log', () => {
  it('records an undoable edit', async () => {
    const pageId = await seeded();
    const ops = repo.ops(pageId);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.at(-1)?.op).toMatchObject({ command: 'block.insert' });
  });

  it('does not record navigation', async () => {
    const pageId = await seeded();
    const before = repo.ops(pageId).length;
    await run('page.open', { id: pageId });
    // Logging page.open would mean a future replay re-applied a navigation.
    expect(repo.ops(pageId).length).toBe(before);
  });

  it('does not record a command that failed', async () => {
    await seeded();
    const before = repo.ops().length;
    const bad = await run('block.moveTo', { id: 'nope', targetId: 'also-nope' });
    expect(bad.ok).toBe(false);
    expect(repo.ops().length).toBe(before);
  });

  it('never rewrites or removes an earlier row', async () => {
    const pageId = await seeded();
    const snapshot = JSON.stringify(repo.ops(pageId));

    // More edits, including an undo, which is the case most likely to try to
    // rewind the log rather than add to it.
    await run('block.insert', { type: 'paragraph', text: 'second' });
    await run('history.undo');
    await run('block.insert', { type: 'paragraph', text: 'third' });

    const after = repo.ops(pageId);
    const nowPrefix = JSON.stringify(after.slice(0, JSON.parse(snapshot).length));
    // Byte-identical prefix. A count check would not catch an in-place edit.
    expect(nowPrefix).toBe(snapshot);
    expect(after.length).toBeGreaterThan(JSON.parse(snapshot).length);
  });

  it('undo appends rather than truncating', async () => {
    const pageId = await seeded();
    const before = repo.ops(pageId).length;
    await run('history.undo');
    const after = repo.ops(pageId);
    // A log that shrank is a log a replay could not trust: the undone op is
    // still something that happened.
    expect(after.length).toBeGreaterThanOrEqual(before);
  });

  it('orders by lamport and never goes backwards', async () => {
    const pageId = await seeded();
    await run('block.insert', { type: 'paragraph', text: 'a' });
    await run('block.insert', { type: 'paragraph', text: 'b' });

    const lamports = repo.ops(pageId).map((o) => o.lamport);
    expect(lamports.length).toBeGreaterThan(1);
    // Strictly increasing: two ops sharing a lamport cannot be ordered, and
    // ordering is the one thing this table is for.
    for (let i = 1; i < lamports.length; i++) {
      expect(lamports[i]!).toBeGreaterThan(lamports[i - 1]!);
    }
  });

  it('stamps every op with the same stable device id', async () => {
    const pageId = await seeded();
    const ids = new Set(repo.ops(pageId).map((o) => o.deviceId));
    expect(ids.size).toBe(1);

    // And it survives a reopen. An id that changed per launch would make every
    // op look like a different machine, which is the first question a merge asks.
    const path = join(dir, 'w.sqlite');
    const first = [...ids][0];
    repo.close();
    repo = await Repository.open(path);
    expect(repo.deviceId()).toBe(first);
  });

  it('survives a reopen with the log intact', async () => {
    const pageId = await seeded();
    const before = repo.ops(pageId);
    const path = join(dir, 'w.sqlite');
    repo.close();
    repo = await Repository.open(path);
    expect(repo.ops(pageId)).toEqual(before);
  });
});
