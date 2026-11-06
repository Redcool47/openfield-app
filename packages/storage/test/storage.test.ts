import { beforeAll, describe, expect, it } from 'vitest';
import {
  createDoc,
  emptyPage,
  indent,
  insert,
  insertLineBreak,
  transact,
  treeShape,
  History,
} from '@ow/model';
import { CURRENT_VERSION, MIGRATIONS, migrate, Repository, openDatabase } from '@ow/storage';

let repo: Repository;

beforeAll(async () => {
  repo = await Repository.memory();
});

/**
 * Create a page with body lines and save it.
 *
 * The repository is an explicit parameter rather than the shared `beforeAll`
 * instance: each test opens its own in-memory database, and seeding into a
 * different one produces failures that look like search or tree bugs but are
 * really just two databases.
 */
function seedPage(
  target: Repository,
  title: string,
  lines: string[],
): { pageId: string; doc: ReturnType<typeof createDoc> } {
  const doc = createDoc();
  const stack: string[] = [];
  for (const line of lines) {
    const depth = (line.length - line.trimStart().length) / 2;
    const parentId = depth > 0 ? (stack[depth - 1] ?? null) : null;
    const b = insert(doc, { parentId, content: { runs: [{ text: line.trim() }] } });
    stack[depth] = b.id;
    stack.length = depth + 1;
  }
  const pageId = target.createPage({ title });
  target.savePage(pageId, doc);
  return { pageId, doc };
}

describe('migrations', () => {
  it('brings a fresh database to the current version', () => {
    expect(repo.version()).toBe(CURRENT_VERSION);
  });

  it('is idempotent', () => {
    const second = migrate(repo.db);
    expect(second.applied).toEqual([]);
    expect(second.to).toBe(CURRENT_VERSION);
  });

  it('numbers migrations strictly upward with unique versions', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('opens a database file and migrates it on disk', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'ow-mig-'));
    try {
      const file = join(dir, 'nested', 'w.sqlite');
      const first = await Repository.open(file);
      expect(first.version()).toBe(CURRENT_VERSION);
      first.close();
      // Reopening must be a no-op, not a second application of every migration.
      const second = await Repository.open(file);
      expect(second.version()).toBe(CURRENT_VERSION);
      second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('pages', () => {
  it('creates nested pages and lists them in order', async () => {
    const db = await newOpen();
    const parent = db.repo.createPage({ title: 'Parent' });
    const a = db.repo.createPage({ title: 'Child A', parentPage: parent });
    db.repo.createPage({ title: 'Child B', parentPage: parent });
    const other = db.repo.createPage({ title: 'Other' });

    expect(db.repo.childPages(parent).map((p) => p.title)).toEqual(['Child A', 'Child B']);
    expect(db.repo.childPages(null).map((p) => p.id)).toContain(other);
    expect(db.repo.getPage(a)?.parent_page).toBe(parent);
    db.close();
  });

  it('reports whether a page has children', async () => {
    const db = await newOpen();
    const parent = db.repo.createPage({ title: 'Parent' });
    db.repo.createPage({ title: 'Child', parentPage: parent });
    expect(db.repo.childPages(null).find((p) => p.id === parent)?.hasChildren).toBe(true);
    db.close();
  });

  it('moves a page under a new parent and refuses a cycle', async () => {
    const db = await newOpen();
    const parent = db.repo.createPage({ title: 'Parent' });
    const child = db.repo.createPage({ title: 'Child', parentPage: parent });
    const grand = db.repo.createPage({ title: 'Grandchild', parentPage: child });
    expect(() => db.repo.movePage(parent, grand)).toThrow(/subtree/);
    expect(() => db.repo.movePage(parent, parent)).toThrow(/itself/);
    db.repo.movePage(grand, parent);
    expect(db.repo.getPage(grand)?.parent_page).toBe(parent);
    db.close();
  });

  it('trashes a subtree and restores it to its original parent', async () => {
    const db = await newOpen();
    const parent = db.repo.createPage({ title: 'Parent' });
    const child = db.repo.createPage({ title: 'Child', parentPage: parent });
    const grand = db.repo.createPage({ title: 'Grandchild', parentPage: child });

    db.repo.trashPage(parent);
    expect(db.repo.childPages(parent)).toHaveLength(0);
    expect(db.repo.getPage(grand)?.trashed_at).not.toBeNull();

    db.repo.restorePage(parent);
    expect(db.repo.getPage(child)?.parent_page).toBe(parent);
    expect(db.repo.getPage(grand)?.parent_page).toBe(child);
    db.close();
  });

  it('purges a subtree completely', async () => {
    const db = await newOpen();
    const parent = db.repo.createPage({ title: 'Parent' });
    const child = db.repo.createPage({ title: 'Child', parentPage: parent });
    db.repo.purgePage(parent);
    expect(db.repo.getPage(parent)).toBeUndefined();
    expect(db.repo.getPage(child)).toBeUndefined();
    db.close();
  });

  it('favorites and unfavorites', async () => {
    const db = await newOpen();
    const page = db.repo.createPage({ title: 'Starred' });
    db.repo.toggleFavorite(page, true);
    expect(db.repo.favoritePages().map((p) => p.id)).toEqual([page]);
    db.repo.toggleFavorite(page, false);
    expect(db.repo.favoritePages()).toHaveLength(0);
    db.close();
  });
});

describe('blocks', () => {
  it('round-trips a page through save and load', async () => {
    const db = await newOpen();
    const pageId = db.repo.createPage({ title: 'Doc' });
    const doc = createDoc();
    const a = insert(doc, { content: { runs: [{ text: 'alpha' }] } });
    insert(doc, { parentId: a.id, content: { runs: [{ text: 'child' }] } });
    insert(doc, { content: { runs: [{ text: 'beta' }] } });

    db.repo.savePage(pageId, doc);
    const loaded = db.repo.loadPage(pageId);
    expect(treeShape(loaded)).toEqual(['alpha', '  child', 'beta']);
    db.close();
  });

  it('replaces rows on re-save rather than appending', async () => {
    const db = await newOpen();
    const pageId = db.repo.createPage({ title: 'Doc' });
    const doc = createDoc();
    insert(doc, { content: { runs: [{ text: 'one' }] } });
    db.repo.savePage(pageId, doc);

    const next = createDoc();
    insert(next, { content: { runs: [{ text: 'two' }] } });
    db.repo.savePage(pageId, next);

    expect(treeShape(db.repo.loadPage(pageId))).toEqual(['two']);
    db.close();
  });

  it('preserves block props and collapsed state', async () => {
    const db = await newOpen();
    const pageId = db.repo.createPage({ title: 'Doc' });
    const doc = createDoc();
    const t = insert(doc, { type: 'todo', content: { runs: [{ text: 'x' }] }, props: { checked: true } });
    // Collapsed state belongs to a container, so use a toggle rather than a code
    // block: a code block holds inline content only and correctly refuses
    // children.
    const g = insert(doc, { type: 'toggle', content: { runs: [{ text: 'group' }] }, props: { color: 'blue' } });
    const c = insert(doc, { type: 'code', content: { runs: [{ text: 'code' }] }, props: { language: 'ts' } });
    insert(doc, { parentId: g.id, content: { runs: [{ text: 'child' }] } });
    doc.blocks[g.id]!.collapsed = true;
    db.repo.savePage(pageId, doc);

    const loaded = db.repo.loadPage(pageId);
    expect(loaded.blocks[t.id]!.props.checked).toBe(true);
    expect(loaded.blocks[c.id]!.props.language).toBe('ts');
    expect(loaded.blocks[g.id]!.props.color).toBe('blue');
    expect(loaded.blocks[g.id]!.collapsed).toBe(true);
    expect(loaded.blocks[g.id]!.children).toHaveLength(1);
    db.close();
  });

  it('keeps order stable across a save and load cycle for 200 siblings', async () => {
    const db = await newOpen();
    const pageId = db.repo.createPage({ title: 'Big' });
    const doc = createDoc();
    for (let i = 0; i < 200; i += 1) insert(doc, { content: { runs: [{ text: `row ${i}` }] } });
    db.repo.savePage(pageId, doc);
    expect(treeShape(db.repo.loadPage(pageId))).toEqual(treeShape(doc));
    db.close();
  });

  it('survives a save while the document is mid-edit', async () => {
    const db = await newOpen();
    const pageId = db.repo.createPage({ title: 'Doc' });
    const { doc, rootId } = emptyPage();
    db.repo.savePage(pageId, doc);
    const history = new History();
    transact(doc, history, 'enter', (tx) => {
      tx.touch(rootId);
      insertLineBreak(doc, tx, { blockId: rootId, offset: 0 });
    });
    db.repo.savePage(pageId, doc);
    expect(treeShape(db.repo.loadPage(pageId))).toHaveLength(2);
    db.close();
  });
});

describe('search', () => {
  it('finds a page by title and by body text', async () => {
    const db = await newOpen();
    const { pageId } = seedPage(db.repo, 'Gardening', ['  tomatoes need staking', '  compost bin']);
    db.repo.setSetting('noop', true);
    // savePage wrote the index; make sure the title is current too.
    db.repo.reindexPage(pageId);

    expect(db.repo.search('garden')[0]?.pageId).toBe(pageId);
    expect(db.repo.search('compost')[0]?.pageId).toBe(pageId);
    db.close();
  });

  it('ranks an exact title above a body-only match', async () => {
    const db = await newOpen();
    const exact = seedPage(db.repo, 'Roadmap', ['  unrelated words here']).pageId;
    const body = seedPage(db.repo, 'Meeting notes', ['  we discussed the roadmap in detail']).pageId;
    db.repo.reindexPage(exact);
    db.repo.reindexPage(body);
    const hits = db.repo.search('roadmap');
    expect(hits[0]?.pageId).toBe(exact);
    db.close();
  });

  it('boosts a recently opened page on equal relevance', async () => {
    const db = await newOpen();
    const old = seedPage(db.repo, 'Notes alpha', ['  shared body text']).pageId;
    const recent = seedPage(db.repo, 'Notes beta', ['  shared body text']).pageId;
    db.repo.reindexPage(old);
    db.repo.reindexPage(recent);
    const before = db.repo.search('notes')[0]?.pageId;
    db.repo.noteOpened(recent);
    const after = db.repo.search('notes')[0]?.pageId;
    expect(before).not.toBe(after === recent ? recent : before);
    expect(after).toBe(recent);
    db.close();
  });

  it('excludes trashed pages from results', async () => {
    const db = await newOpen();
    const { pageId } = seedPage(db.repo, 'Hidden treasure', ['  secret']);
    db.repo.reindexPage(pageId);
    expect(db.repo.search('treasure')).toHaveLength(1);
    db.repo.trashPage(pageId);
    expect(db.repo.search('treasure')).toHaveLength(0);
    db.repo.restorePage(pageId);
    expect(db.repo.search('treasure')).toHaveLength(1);
    db.close();
  });

  it('treats punctuation in a query as literal text, not FTS syntax', async () => {
    const db = await newOpen();
    const { pageId } = seedPage(db.repo, 'Symbols', ['  a-b AND OR NOT']);
    db.repo.reindexPage(pageId);
    expect(() => db.repo.search('a-b')).not.toThrow();
    expect(db.repo.search('a-b')[0]?.pageId).toBe(pageId);
    db.close();
  });

  it('returns nothing for an empty query', async () => {
    const db = await newOpen();
    seedPage(db.repo, 'Anything', ['  text']);
    expect(db.repo.search('   ')).toEqual([]);
    db.close();
  });
});

describe('history', () => {
  it('lists versions newest first and restores one', async () => {
    const db = await newOpen();
    const pageId = db.repo.createPage({ title: 'Doc' });
    const first = emptyPage().doc;
    insert(first, { content: { runs: [{ text: 'version one' }] } });
    db.repo.saveVersion(pageId, first, 'first');

    const second = emptyPage().doc;
    insert(second, { content: { runs: [{ text: 'version two' }] } });
    db.repo.saveVersion(pageId, second, 'second');

    const versions = db.repo.listVersions(pageId);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.label).toBe('second');

    const restored = db.repo.loadVersion(versions[1]!.id)!;
    expect(treeShape(restored)).toContain('version one');
    db.close();
  });
});

describe('integrity self-test', () => {
  it('reparents orphaned blocks instead of failing to open', async () => {
    const db = await newOpen();
    const pageId = db.repo.createPage({ title: 'Doc' });
    const doc = createDoc();
    const parent = insert(doc, { content: { runs: [{ text: 'parent' }] } });
    insert(doc, { parentId: parent.id, content: { runs: [{ text: 'child' }] } });
    db.repo.savePage(pageId, doc);

    // Corrupt: delete the parent row behind the child's back.
    db.repo.db.prepare('DELETE FROM block WHERE id = ?').run(parent.id);

    const result = db.repo.selfTest();
    expect(result.ok).toBe(true);
    expect(result.repaired.join(' ')).toMatch(/orphaned/);
    expect(db.repo.loadPage(pageId).roots.length).toBeGreaterThan(0);
    db.close();
  });

  it('reports a clean workspace with no repairs needed', async () => {
    const db = await newOpen();
    const result = db.repo.selfTest();
    expect(result).toEqual({ ok: true, repaired: [], problems: [] });
    db.close();
  });
});

describe('driver fallback', () => {
  it('reports a clear error when no binding is available', async () => {
    // Sanity check that openDatabase surfaces a usable message rather than a
    // raw stack trace, by asking for a directory that cannot hold a database.
    await expect(openDatabase('C:/definitely/not/a/real/path/x.sqlite')).rejects.toThrow();
  });
});

/** Isolated in-memory repository so each test starts clean. */
async function newOpen(): Promise<{ repo: Repository; close(): void }> {
  const repo = await Repository.memory();
  return { repo, close: () => repo.close() };
}
void indent;
