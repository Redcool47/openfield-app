/**
 * page.move, and the way it was silently losing pages.
 *
 * The bug this is built around: an empty `parentPage` means "top level", and
 * `?? null` does not catch it because `''` is not nullish. It was written
 * straight into `parent_page`, producing a page whose parent does not exist.
 * The tree walk starts at the root and never visits it, so the command reported
 * success and the page disappeared from the sidebar with no way back -- and the
 * sidebar's own "Move to..." top-level entry passes exactly that value.
 *
 * A page you cannot see is close to a page you have lost, so every assertion
 * here is about whether the page is still reachable afterwards.
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
  dir = await mkdtemp(join(tmpdir(), 'ow-move-'));
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

const create = async (title: string, parentPage?: string) =>
  (await run('page.create', parentPage === undefined ? { title } : { title, parentPage })).value as { id: string };

/** Every page the sidebar's tree walk would show. */
const visible = (): string[] => repo.childPages(null).map((p) => p.title);

describe('page.move', () => {
  it('moves a page under a new parent', async () => {
    const child = await create('Child');
    const parent = await create('Parent');
    expect((await run('page.move', { id: child.id, parentPage: parent.id })).ok).toBe(true);
    expect(repo.getPage(child.id)?.parent_page).toBe(parent.id);
  });

  it('treats an empty parentPage as the top level', async () => {
    const parent = await create('Parent');
    const child = await create('Child', parent.id);
    expect(child.parentPage).toBeUndefined();

    // The value the sidebar's own "Move to..." entry sends for the root.
    expect((await run('page.move', { id: child.id, parentPage: '' })).ok).toBe(true);

    expect(repo.getPage(child.id)?.parent_page).toBeNull();
    // Still reachable. Before the fix this wrote '' into parent_page and the
    // page left the tree with no parent that exists.
    expect(visible()).toContain('Child');
  });

  it('treats a whitespace-only parentPage as the top level', async () => {
    const parent = await create('Parent');
    const child = await create('Child', parent.id);
    await run('page.move', { id: child.id, parentPage: '   ' });
    expect(repo.getPage(child.id)?.parent_page).toBeNull();
    expect(visible()).toContain('Child');
  });

  it('treats an omitted parentPage as the top level', async () => {
    const parent = await create('Parent');
    const child = await create('Child', parent.id);
    await run('page.move', { id: child.id });
    expect(repo.getPage(child.id)?.parent_page).toBeNull();
  });

  it('never leaves a page whose parent does not exist', async () => {
    // The general shape of the bug: any parent id that is not a real page
    // strands the page. The cycle guard stops a page being moved into its own
    // child, but nothing stopped a move to a non-existent parent.
    const parent = await create('Parent');
    const child = await create('Child', parent.id);
    await run('page.move', { id: child.id, parentPage: '' });
    await run('page.move', { id: child.id, parentPage: parent.id });

    const orphans = repo
      .childPages(null)
      .concat(repo.childPages(parent.id))
      .filter((p) => repo.getPage(p.id)?.parent_page === undefined || repo.getPage(p.id)?.parent_page === null)
      .map((p) => p.title);
    expect(orphans).not.toContain('Child');
  });

  it('refuses to move a page inside its own subtree', async () => {
    const root = await create('Root');
    const mid = await create('Mid', root.id);
    await create('Leaf', mid.id);

    const bad = await run('page.move', { id: root.id, parentPage: mid.id });
    expect(bad.ok).toBe(false);
    expect(repo.getPage(root.id)?.parent_page).toBeNull();
  });

  it('refuses to move a page into itself', async () => {
    const a = await create('A');
    const bad = await run('page.move', { id: a.id, parentPage: a.id });
    expect(bad.ok).toBe(false);
  });

  it('survives a reopen, because the parent is in the database', async () => {
    const child = await create('Child');
    const parent = await create('Parent');
    await run('page.move', { id: child.id, parentPage: parent.id });

    const path = join(dir, 'w.sqlite');
    repo.close();
    repo = await Repository.open(path);
    expect(repo.getPage(child.id)?.parent_page).toBe(parent.id);
  });
});
