/**
 * Page history.
 *
 * The requirement is specific: versions are listed, previewable and restorable,
 * and **restoring creates a new version rather than destroying old ones**. That
 * last clause is the one worth testing, because a restore that overwrote the
 * history would make the history lossy in exactly the situation where you need
 * it — and it would look like it worked.
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
  dir = await mkdtemp(join(tmpdir(), 'ow-history-'));
  repo = await Repository.open(join(dir, 'w.sqlite'));
  repo.ensureWorkspace('default', 'W');
  // A version every transaction, so the test does not have to make 25 edits.
  session = new Session(repo, { autosaveMs: 0, versionEvery: 1 });
  registry = createRegistry();
});

afterEach(async () => {
  session.dispose();
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

const run = (id: string, args: Record<string, unknown> = {}) =>
  runCommand(id, args, { session, registry, soft: true });

/** A page with one paragraph, open. */
async function seeded(text = 'original'): Promise<string> {
  const page = (await run('page.create', { title: 'History' })).value as { id: string };
  await run('page.open', { id: page.id });
  await run('block.insert', { type: 'paragraph', text });
  return page.id;
}

describe('page history', () => {
  it('saves a version as the page changes', async () => {
    const pageId = await seeded();
    const listed = await run('history.versions.list', { pageId });
    expect(listed.ok).toBe(true);
    const versions = (listed.value as { versions: unknown[] }).versions;
    expect(versions.length).toBeGreaterThan(0);
  });

  it('lists versions newest first', async () => {
    const pageId = await seeded('one');
    await run('block.setText', { id: (await run('block.insert', { type: 'paragraph', text: 'two' })).value && '' });
    const listed = await run('history.versions.list', { pageId });
    const versions = (listed.value as { versions: { createdAt: number }[] }).versions;
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i - 1]!.createdAt).toBeGreaterThanOrEqual(versions[i]!.createdAt);
    }
  });

  it('previews a version as readable text', async () => {
    const pageId = await seeded('the original wording');
    const listed = await run('history.versions.list', { pageId });
    const first = (listed.value as { versions: { id: string }[] }).versions[0]!;

    const preview = await run('history.versions.preview', { versionId: first.id });
    expect(preview.ok).toBe(true);
    expect((preview.value as { text: string }).text).toContain('the original wording');
  });

  it('restores old content', async () => {
    const pageId = await seeded('the original wording');
    const listed = await run('history.versions.list', { pageId });
    const versionId = (listed.value as { versions: { id: string }[] }).versions[0]!.id;

    // Change the page.
    const blockId = (await run('block.insert', { type: 'paragraph', text: 'something else' })).value as { id: string };
    await run('block.setText', { id: blockId.id, text: 'completely different now' });

    const restored = await run('history.versions.restore', { versionId });
    expect(restored.ok).toBe(true);

    const after = await run('history.versions.list', { pageId });
    const newest = (after.value as { versions: { id: string }[] }).versions[0]!;
    const preview = await run('history.versions.preview', { versionId: newest.id });
    expect((preview.value as { text: string }).text).toContain('the original wording');
  });

  it('restoring creates a new version instead of destroying the old ones', async () => {
    const pageId = await seeded('the original wording');
    const before = (await run('history.versions.list', { pageId })).value as { versions: unknown[] };
    const versionId = (before.versions[0] as { id: string }).id;

    await run('history.versions.restore', { versionId });

    const after = (await run('history.versions.list', { pageId })).value as { versions: unknown[] };
    // More versions than before, not fewer. A restore that overwrote the
    // history would be lossy in exactly the situation where you need it.
    expect(after.versions.length).toBeGreaterThan(before.versions.length);

    // And the version we restored from is still there.
    const ids = after.versions.map((v) => (v as { id: string }).id);
    expect(ids).toContain(versionId);
  });

  it('refuses a version that does not exist', async () => {
    await seeded();
    const preview = await run('history.versions.preview', { versionId: 'no-such-version' });
    expect(preview.ok).toBe(false);
    const restore = await run('history.versions.restore', { versionId: 'no-such-version' });
    expect(restore.ok).toBe(false);
  });

  it('refuses to list versions of a page that does not exist', async () => {
    const listed = await run('history.versions.list', { pageId: 'no-such-page' });
    expect(listed.ok).toBe(false);
  });
});
