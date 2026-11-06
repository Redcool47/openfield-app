/**
 * Page lock, last-edited, and backlinks.
 *
 * Three features that share the page surface, and one lesson underneath them:
 * the `locked` column has been in the schema since the first migration with
 * nothing writing to it, and `updated_at` has been there the whole time. A
 * column is not a feature.
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
  dir = await mkdtemp(join(tmpdir(), 'ow-page-'));
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

describe('page lock', () => {
  it('locks and unlocks a page', async () => {
    const page = (await run('page.create', { title: 'Secret' })).value as { id: string };
    expect(repo.getPage(page.id)?.locked).toBe(0);

    const locked = await run('page.lock', { id: page.id });
    expect(locked.ok, locked.error).toBe(true);
    expect(repo.getPage(page.id)?.locked).toBe(1);

    const unlocked = await run('page.lock', { id: page.id, locked: false });
    expect(unlocked.ok, unlocked.error).toBe(true);
    expect(repo.getPage(page.id)?.locked).toBe(0);
  });

  it('refuses to lock a page that does not exist', async () => {
    const bad = await run('page.lock', { id: 'no-such-page' });
    expect(bad.ok).toBe(false);
  });
});

describe('backlinks', () => {
  it('finds the pages that mention this one', async () => {
    const target = (await run('page.create', { title: 'Target' })).value as { id: string };
    const source = (await run('page.create', { title: 'Source' })).value as { id: string };
    await run('page.open', { id: source.id });

    // A mention is an inline node in the block's content.
    const block = await run('block.insert', { type: 'paragraph', text: 'see the plan' });
    const blockId = (block.value as { id: string }).id;
    await run('inline.page.set', { id: blockId, from: 0, to: 0, pageId: target.id });

    const listed = await run('page.backlinks', { id: target.id });
    expect(listed.ok, listed.error).toBe(true);
    const backlinks = (listed.value as { backlinks: { pageId: string }[] }).backlinks;
    expect(backlinks.map((b) => b.pageId)).toContain(source.id);
  });

  it('does not report a page that merely contains the id as text', async () => {
    const target = (await run('page.create', { title: 'Target' })).value as { id: string };
    const source = (await run('page.create', { title: 'Source' })).value as { id: string };
    await run('page.open', { id: source.id });
    await run('block.insert', { type: 'paragraph', text: `the id is ${target.id} but this is not a mention` });

    const listed = await run('page.backlinks', { id: target.id });
    const backlinks = (listed.value as { backlinks: { pageId: string }[] }).backlinks;
    // The SQL narrows with a LIKE; the rows are then parsed and checked. A LIKE
    // match alone would report this page, and the section would list a
    // "mention" that is not one.
    expect(backlinks.map((b) => b.pageId)).not.toContain(source.id);
  });

  it('does not report a page as mentioning itself', async () => {
    const page = (await run('page.create', { title: 'Self' })).value as { id: string };
    await run('page.open', { id: page.id });
    const block = await run('block.insert', { type: 'paragraph', text: 'note' });
    await run('inline.page.set', {
      id: (block.value as { id: string }).id,
      from: 0,
      to: 0,
      pageId: page.id,
    });
    const listed = await run('page.backlinks', { id: page.id });
    const backlinks = (listed.value as { backlinks: { pageId: string }[] }).backlinks;
    expect(backlinks.map((b) => b.pageId)).not.toContain(page.id);
  });
});
