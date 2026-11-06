/**
 * Slice 1 gate: the whole page-tree slice driven through the command registry.
 *
 * These are the "headless scenario tests" the design calls for. They are the
 * primary test surface, not a secondary one, because they exercise the same
 * command ids the UI and the CLI use. A scenario that cannot run headlessly
 * cannot be verified by an agent, and an unverifiable feature is a feature
 * nobody can tell is broken.
 *
 * Every step goes through `runCommand`, so nothing here can reach into the model
 * in a way the product itself could not.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '@ow/storage';
import { Session, createRegistry, runBatch, runCommand } from '@ow/commands';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let repo: Repository;
let session: Session;
let registry: ReturnType<typeof createRegistry>;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ow-scenario-'));
  repo = await Repository.open(join(dir, 'w.sqlite'));
  repo.ensureWorkspace('default', 'Test workspace');
  session = new Session(repo, { autosaveMs: 0 });
  registry = createRegistry();
});

const run = (id: string, args: Record<string, unknown> = {}) =>
  runCommand(id, args, { session, registry, soft: true });

describe('scenario: build a page tree and use it', () => {
  it('walks the whole operator requirement end to end', async () => {
    // --- create five nested pages -----------------------------------------
    const root = (await run('page.create', { title: 'Home' })).value as { id: string };
    expect(root.id).toBeTruthy();

    const results = await runBatch(
      [
        { id: 'page.create', args: { title: 'Projects', parentPage: root.id } },
        { id: 'page.create', args: { title: 'Reading', parentPage: root.id } },
        { id: 'page.create', args: { title: 'Alpha', parentPage: root.id } },
        { id: 'page.create', args: { title: 'Beta', parentPage: root.id } },
      ],
      { session, registry },
    );
    expect(results.every((r) => r.ok)).toBe(true);

    const children = repo.childPages(root.id).map((p) => p.title);
    expect(children).toEqual(['Projects', 'Reading', 'Alpha', 'Beta']);

    // Nest one level deeper, proving nesting is not limited to one level.
    const projects = repo.childPages(root.id).find((p) => p.title === 'Projects')!;
    const deep = (await run('page.create', { title: 'Deep', parentPage: projects.id })).value as {
      id: string;
    };
    expect(repo.childPages(projects.id).map((p) => p.id)).toContain(deep.id);

    // --- favorite two ------------------------------------------------------
    const alpha = repo.childPages(root.id).find((p) => p.title === 'Alpha')!;
    const beta = repo.childPages(root.id).find((p) => p.title === 'Beta')!;
    await run('page.favorite.toggle', { favorite: true });
    expect(repo.favoritePages()).toHaveLength(0); // no page open, so this is a no-op
    await run('page.open', { id: alpha.id });
    await run('page.favorite.toggle', { favorite: true });
    await run('page.open', { id: beta.id });
    await run('page.favorite.toggle', { favorite: true });
    expect(repo.favoritePages().map((p) => p.title).sort()).toEqual(['Alpha', 'Beta']);

    // --- write into a page -------------------------------------------------
    session.openPage(projects.id);
    await run('block.insert', { type: 'heading1', text: 'Projects' });
    await run('block.insert', { type: 'paragraph', text: 'A line of prose.' });
    await run('block.insert', { type: 'bulletedListItem', text: 'First bullet' });
    const bullet = session.findBlockByText('First bullet')!.id;
    await run('block.insert', { type: 'paragraph', text: 'A nested detail', parentId: bullet });
    await run('block.insert', { type: 'todo', text: 'A task' });
    // The seeded empty paragraph is still there; it is the caret target.
    expect(session.inspect().tree).toEqual([
      '—',
      'Projects',
      'A line of prose.',
      'First bullet',
      '  A nested detail',
      'A task',
    ]);

    // --- trash a page WITHOUT opening it (operator requirement R2) -------
// The sidebar row menu passes an id, so the page need never be the open one.
    session.openPage(projects.id);
    await run('block.insert', { type: 'paragraph', text: 'Still here' });
    expect(repo.getPage(alpha.id)?.trashed_at).toBeNull();

    const trashed = await run('page.moveToTrash', { id: alpha.id });
    expect(trashed.ok).toBe(true);
    expect(repo.getPage(alpha.id)?.trashed_at).not.toBeNull();
    expect(repo.trashedPages().map((p) => p.title)).toContain('Alpha');
    expect(repo.childPages(root.id).map((p) => p.title)).not.toContain('Alpha');
    // The open page was untouched, because we trashed a different one.
    expect(session.pageId).toBe(projects.id);

    // --- restore -----------------------------------------------------------
    await run('page.restore', { id: alpha.id });
    expect(repo.trashedPages().map((p) => p.title)).not.toContain('Alpha');
    expect(repo.childPages(root.id).map((p) => p.title)).toContain('Alpha');

    // --- search ------------------------------------------------------------
    repo.reindexPage(projects.id);
    const hits = repo.search('bullet');
    expect(hits.map((h) => h.title)).toContain('Projects');

    // --- the workspace is still structurally sound -------------------------
    const check = repo.selfTest();
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);

    session.dispose();
  });
});

describe('scenario: writing with the keyboard model', () => {
  it('splits, indents, toggles and undoes like a block editor', async () => {
    const page = (await run('page.create', { title: 'Notes' })).value as { id: string };
    session.openPage(page.id);
    await run('block.insert', { type: 'paragraph', text: 'first' });

    // A new page is seeded with one empty paragraph so the editor always has a
    // caret target, so targeting "the first block" would be the empty one.
    // Target the block by its text, which is also what an agent would do.
    const root = session.findBlockByText('first')!.id;
    expect(session.inspect().tree).toEqual(['—', 'first']);

    // Enter at the end of the block creates a sibling below it.
    await run('block.enter', { id: root, offset: 5 });
    expect(session.inspect().tree).toEqual(['—', 'first', '—']);

    const tail = session.doc.roots[2]!;
    await run('block.turnInto.bulletedListItem', { id: tail });
    await run('block.insert', { type: 'paragraph', text: 'bullet', parentId: tail });
    // The empty list item still renders, with its child indented under it.
    expect(session.inspect().tree).toEqual(['—', 'first', '—', '  bullet']);

    // Undo walks back one user intent at a time.
    expect(session.undo()).toBe(true);
    expect(session.inspect().tree).toEqual(['—', 'first', '—']);
    expect(session.redo()).toBe(true);
    expect(session.inspect().tree).toEqual(['—', 'first', '—', '  bullet']);

    // Indent then outdent returns to the starting shape.
    const before = session.inspect().tree;
    await run('block.indent', { id: root });
    expect(session.inspect().tree).not.toEqual(before);
    await run('block.outdent', { id: root });
    expect(session.inspect().tree).toEqual(before);

    session.dispose();
  });
});

describe('scenario: every command is well formed', () => {
  it('has unique, well-formed ids and no dangling keyboard chords', () => {
    const ids = registry.all().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
    }
    // A conflict means two commands respond to one keystroke, which is a bug.
    expect(registry.keyConflicts()).toEqual([]);
  });

  it('documents every command with a title and category', () => {
    for (const command of registry.all()) {
      expect(command.title.length).toBeGreaterThan(0);
      expect(command.category.length).toBeGreaterThan(0);
      expect(typeof command.run).toBe('function');
    }
  });

  it('finds commands by fuzzy query', () => {
    expect(registry.search('trash')[0]?.id).toBe('page.moveToTrash');
    expect(registry.search('undo')[0]?.id).toBe('history.undo');
    expect(registry.search('zzzznothing')).toEqual([]);
  });

  it('rejects an unknown command with a clear message', async () => {
    const result = await run('page.definitelyNotAThing');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no such command/);
  });

  it('rejects a missing required argument', async () => {
    const result = await run('page.rename');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing required argument/);
  });

  it('rejects an argument of the wrong type', async () => {
    const result = await run('block.insert', { type: 'paragraph', text: 42 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must be a string/);
  });

  it('rejects a value outside an enum', async () => {
    const result = await run('block.insert', { type: 'notARealBlockType' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must be one of/);
  });

  it('refuses to trash a page into its own subtree', async () => {
    const parent = (await run('page.create', { title: 'Parent' })).value as { id: string };
    const child = (await run('page.create', { title: 'Child', parentPage: parent.id })).value as {
      id: string;
    };
    const result = await run('page.move', { id: parent.id, parentPage: child.id });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/subtree/);
  });
});

describe('scenario: persistence survives a restart', () => {
  it('reloads a page exactly as it was written', async () => {
    const page = (await run('page.create', { title: 'Durable' })).value as { id: string };
    session.openPage(page.id);
    await run('block.insert', { type: 'heading2', text: 'Section' });
    await run('block.insert', { type: 'paragraph', text: 'Body text' });
    await run('mark.bold.toggle', { id: session.doc.roots[1]!, from: 0, to: 4 });
    const before = session.inspect().tree;
    session.dispose();
    repo.close();

    // Reopen the same file from scratch, as a second launch would.
    const reopened = await Repository.open(join(dir, 'w.sqlite'));
    const fresh = new Session(reopened, { autosaveMs: 0 });
    fresh.openPage(page.id);
    expect(fresh.inspect().tree).toEqual(before);
    expect(reopened.loadPage(page.id).blocks[fresh.doc.roots[1]!]!.content.runs[0]!.marks).toEqual([
      'bold',
    ]);
    fresh.dispose();
    reopened.close();

    await rm(dir, { recursive: true, force: true });
  });
});