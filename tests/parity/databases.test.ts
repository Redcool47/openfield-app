/**
 * Databases, driven through the command registry.
 *
 * The tables for collections, views and property values have existed in the
 * schema since v1 and had no code behind them at all, so this file is the first
 * thing that has ever written to them. That makes it worth pinning down: an
 * unnoticed failure here would not throw, it would silently lose data.
 *
 * Every step goes through a command id, so nothing here can reach into storage
 * in a way the product itself could not.
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
  dir = await mkdtemp(join(tmpdir(), 'ow-db-'));
  repo = await Repository.open(join(dir, 'w.sqlite'));
  repo.ensureWorkspace('default', 'Test workspace');
  session = new Session(repo, { autosaveMs: 0 });
  registry = createRegistry();
});

afterEach(async () => {
  session.dispose();
  repo.close();
  await rm(dir, { recursive: true, force: true });
});

async function run(id: string, args: Record<string, unknown> = {}) {
  return runCommand(id, args, { session, registry, soft: true });
}

async function makeDb(name = 'Tasks') {
  const created = await run('db.create', { name });
  expect(created.ok).toBe(true);
  return created.value as { id: string; pageId: string; viewId: string };
}

describe('databases', () => {
  it('creates a database with a page, a default view and two starter properties', async () => {
    const db = await makeDb();
    const listed = await run('db.list', { pageId: db.pageId });
    expect(listed.ok).toBe(true);
    const collections = listed.value as { id: string; schema: { properties: { name: string }[] } }[];
    expect(collections).toHaveLength(1);
    expect(collections[0]!.schema.properties.map((p) => p.name)).toEqual(['Name', 'Status']);

    const rows = await run('db.rows', { collectionId: db.id });
    const views = (rows.value as { views: { type: string }[] }).views;
    expect(views.map((v) => v.type)).toEqual(['table']);
  });

  it('adds a property of each supported type', async () => {
    const db = await makeDb();
    for (const [name, type] of [
      ['Due', 'date'],
      ['Done', 'checkbox'],
      ['Points', 'number'],
      ['Tags', 'multiSelect'],
      ['Refs', 'relation'],
    ] as const) {
      const added = await run('db.property.add', { collectionId: db.id, name, type });
      expect(added.ok, `${name} should be accepted`).toBe(true);
    }
    const stored = repo.databases.getCollection(db.id)!.schema.properties.map((p) => p.type);
    expect(stored).toContain('date');
    expect(stored).toContain('checkbox');
    expect(stored).toContain('number');
    expect(stored).toContain('multiSelect');
    expect(stored).toContain('relation');
  });

  it('refuses a property type it cannot draw', async () => {
    // The renderer branches on type. An unknown one would produce a cell that
    // silently renders nothing, so it is rejected at the door with a message
    // naming what was expected.
    const db = await makeDb();
    const bad = await run('db.property.add', { collectionId: db.id, name: 'X', type: 'nonsense' });
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toMatch(/unknown property type/i);
    expect(repo.databases.getCollection(db.id)!.schema.properties.map((p) => p.name)).not.toContain('X');
  });

  it('round-trips a typed value per property type', async () => {
    const db = await makeDb();
    for (const [name, type] of [['Due', 'date'], ['Done', 'checkbox'], ['Points', 'number']] as const) {
      await run('db.property.add', { collectionId: db.id, name, type });
    }
    const row = await run('db.row.add', { collectionId: db.id, title: 'Ship it' });
    const pageId = (row.value as { id: string }).id;

    await run('db.value.set', { collectionId: db.id, pageId, propertyId: 'prop-due', value: '2027-03-08' });
    await run('db.value.set', { collectionId: db.id, pageId, propertyId: 'prop-done', value: true });
    await run('db.value.set', { collectionId: db.id, pageId, propertyId: 'prop-points', value: 13 });

    const read = await run('db.rows', { collectionId: db.id });
    const rows = (read.value as { rows: { title: string; values: Record<string, unknown> }[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Ship it');
    // The tag travels with the value, so the renderer knows which cell to draw.
    expect(rows[0]!.values['prop-due']).toEqual({ type: 'date', date: '2027-03-08' });
    expect(rows[0]!.values['prop-done']).toEqual({ type: 'checkbox', checked: true });
    expect(rows[0]!.values['prop-points']).toEqual({ type: 'number', number: 13 });
  });

  it('coerces a value that does not match its type rather than storing it raw', async () => {
    const db = await makeDb();
    await run('db.property.add', { collectionId: db.id, name: 'Points', type: 'number' });
    const row = await run('db.row.add', { collectionId: db.id, title: 'R' });
    const pageId = (row.value as { id: string }).id;

    // Not a number. Stored as null rather than as the string "banana", so a
    // numeric column cannot later contain text.
    await run('db.value.set', { collectionId: db.id, pageId, propertyId: 'prop-points', value: 'banana' });
    const read = await run('db.rows', { collectionId: db.id });
    const rows = (read.value as { rows: { values: Record<string, unknown> }[] }).rows;
    expect(rows[0]!.values['prop-points']).toEqual({ type: 'number', number: null });
  });

  it('treats an empty number as empty, not as zero', async () => {
    // Number(null) and Number('') are both 0. Without this, clearing a number
    // cell fills the column with zeros and the user cannot tell a real zero from
    // an empty field -- which matters the moment anything sums the column.
    const db = await makeDb();
    await run('db.property.add', { collectionId: db.id, name: 'Points', type: 'number' });
    const row = await run('db.row.add', { collectionId: db.id, title: 'R' });
    const pageId = (row.value as { id: string }).id;

    for (const empty of [null, undefined, '']) {
      await run('db.value.set', { collectionId: db.id, pageId, propertyId: 'prop-points', value: empty });
      const read = await run('db.rows', { collectionId: db.id });
      const rows = (read.value as { rows: { values: Record<string, unknown> }[] }).rows;
      expect(rows[0]!.values['prop-points'], `${JSON.stringify(empty)} should be empty`).toEqual({
        type: 'number',
        number: null,
      });
    }

    // A real zero must still be a zero.
    await run('db.value.set', { collectionId: db.id, pageId, propertyId: 'prop-points', value: 0 });
    const read = await run('db.rows', { collectionId: db.id });
    const rows = (read.value as { rows: { values: Record<string, unknown> }[] }).rows;
    expect(rows[0]!.values['prop-points']).toEqual({ type: 'number', number: 0 });
  });

  it('updates a value in place rather than appending a duplicate', async () => {
    const db = await makeDb();
    await run('db.property.add', { collectionId: db.id, name: 'Points', type: 'number' });
    const row = await run('db.row.add', { collectionId: db.id, title: 'R' });
    const pageId = (row.value as { id: string }).id;

    await run('db.value.set', { collectionId: db.id, pageId, propertyId: 'prop-points', value: 1 });
    await run('db.value.set', { collectionId: db.id, pageId, propertyId: 'prop-points', value: 2 });

    const values = repo.databases.valuesForPage(pageId);
    expect(values.get('prop-points')).toEqual({ type: 'number', number: 2 });
    expect(values.size).toBe(1);
  });

  it('renames a property without changing its type unless asked', async () => {
    const db = await makeDb();
    const renamed = await run('db.property.rename', { collectionId: db.id, propertyId: 'prop-status', name: 'Stage' });
    expect(renamed.ok).toBe(true);
    const props = repo.databases.getCollection(db.id)!.schema.properties;
    expect(props.find((p) => p.id === 'prop-status')!.name).toBe('Stage');
    // Renaming must not silently retype a column and orphan its values.
    expect(props.find((p) => p.id === 'prop-status')!.type).toBe('select');
  });

  it('refuses an operation naming a collection that does not exist', async () => {
    const rows = await run('db.rows', { collectionId: 'nope' });
    expect(rows.ok).toBe(false);
    expect(String(rows.error)).toMatch(/no such collection/i);
  });

  it('orders rows by their position in the page tree', async () => {
    const db = await makeDb();
    for (const title of ['First', 'Second', 'Third']) {
      await run('db.row.add', { collectionId: db.id, title });
    }
    const read = await run('db.rows', { collectionId: db.id });
    const rows = (read.value as { rows: { title: string }[] }).rows;
    expect(rows.map((r) => r.title)).toEqual(['First', 'Second', 'Third']);
  });

  it('survives a corrupt schema rather than failing the page', async () => {
    // Reading is best-effort on purpose: a database whose schema JSON has been
    // mangled should display as empty, not take the whole document down.
    const db = await makeDb();
    repo.db.prepare('UPDATE collection SET schema_json = ? WHERE id = ?').run('{not json', db.id);
    expect(repo.databases.getCollection(db.id)!.schema.properties).toEqual([]);
    expect(repo.databases.listCollections(db.pageId)).toHaveLength(1);
  });
});
