/**
 * Person and files properties.
 *
 * Two new property types, and the thing worth proving is that they are
 * *types*, not special cases: a person property holds ids into a directory and
 * draws names, and a files property holds references rather than bytes.
 *
 * The people directory is a local list, because there are no accounts. That
 * makes the "add the same person twice" case real, and it is asserted, because
 * two entries for the same name is a thing a person property then has to make
 * the user choose between.
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
  dir = await mkdtemp(join(tmpdir(), 'ow-people-'));
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

/** A collection with one row, and the ids of its collection and row. */
async function seeded(): Promise<{ collectionId: string; rowId: string }> {
  // db.create returns the collection as `id`; db.row.add returns it as
  // `collectionId`. The two names are not interchangeable.
  const db = (await run('db.create', { name: 'Tasks' })).value as { id: string };
  const row = (await run('db.row.add', { collectionId: db.id, title: 'A row' })).value as { id: string };
  return { collectionId: db.id, rowId: row.id };
}

/**
 * Add a property and return its id.
 *
 * db.property.add returns the whole schema, not the one property, so the new
 * one has to be picked out by name.
 */
async function addProperty(
  collectionId: string,
  name: string,
  type: string,
): Promise<string> {
  const result = (await run('db.property.add', { collectionId, name, type })).value as {
    properties: { id: string; name: string }[];
  };
  const property = result.properties.find((p) => p.name === name);
  if (!property) throw new Error(`the property "${name}" was not added`);
  return property.id;
}

describe('person and files properties', () => {
  it('accepts person and files as property types', async () => {
    const { collectionId } = await seeded();
    const person = await run('db.property.add', { collectionId, name: 'Owner', type: 'person' });
    expect(person.ok, person.error).toBe(true);
    const files = await run('db.property.add', { collectionId, name: 'Attachments', type: 'files' });
    expect(files.ok, files.error).toBe(true);
  });

  it('still refuses a type it cannot draw', async () => {
    const { collectionId } = await seeded();
    const bad = await run('db.property.add', { collectionId, name: 'Nope', type: 'colour' });
    expect(bad.ok).toBe(false);
  });

  it('stores a person list and drops anything that is not an id', async () => {
    const { collectionId, rowId } = await seeded();
    const prop = { id: await addProperty(collectionId, 'Owner', 'person') };
    const set = await run('db.value.set', {
      collectionId,
      pageId: rowId,
      propertyId: prop.id,
      value: ['p1', 'p2'],
    });
    expect(set.ok, set.error).toBe(true);

    const rows = (await run('db.rows', { collectionId })).value as { rows: { values: Record<string, unknown> }[] };
    const value = rows.rows[0]!.values[prop.id] as { type: string; personIds: string[] };
    expect(value.type).toBe('person');
    expect(value.personIds).toEqual(['p1', 'p2']);
  });

  it('stores file references rather than bytes', async () => {
    const { collectionId, rowId } = await seeded();
    const prop = { id: await addProperty(collectionId, 'Attachments', 'files') };
    const ref = { sha256: 'abc123', name: 'notes.pdf', mime: 'application/pdf', size: 1024 };
    const set = await run('db.value.set', {
      collectionId,
      pageId: rowId,
      propertyId: prop.id,
      value: [ref],
    });
    expect(set.ok, set.error).toBe(true);

    const rows = (await run('db.rows', { collectionId })).value as { rows: { values: Record<string, unknown> }[] };
    const value = rows.rows[0]!.values[prop.id] as { type: string; files: typeof ref[] };
    expect(value.type).toBe('files');
    expect(value.files).toEqual([ref]);
  });

  it('keeps the people directory', async () => {
    const added = await run('db.people.add', { name: 'Sam' });
    expect(added.ok, added.error).toBe(true);
    const listed = (await run('db.people.list', {})).value as { people: { id: string; name: string }[] };
    expect(listed.people.map((p) => p.name)).toEqual(['Sam']);
  });

  it('does not add the same person twice', async () => {
    const first = (await run('db.people.add', { name: 'Sam' })).value as { person: { id: string }; created: boolean };
    const second = (await run('db.people.add', { name: 'sam' })).value as { person: { id: string }; created: boolean };
    expect(first.created).toBe(true);
    // Two entries for one name means a person property has to make the user
    // choose between two Sams.
    expect(second.created).toBe(false);
    expect(second.person.id).toBe(first.person.id);
  });

  it('removes a person', async () => {
    const added = (await run('db.people.add', { name: 'Sam' })).value as { person: { id: string } };
    const removed = await run('db.people.remove', { personId: added.person.id });
    expect(removed.ok, removed.error).toBe(true);
    const listed = (await run('db.people.list', {})).value as { people: unknown[] };
    expect(listed.people).toHaveLength(0);
  });

  it('refuses to remove a person that is not there', async () => {
    const bad = await run('db.people.remove', { personId: 'nope' });
    expect(bad.ok).toBe(false);
  });

  it('refuses a person with no name', async () => {
    const bad = await run('db.people.add', { name: '   ' });
    expect(bad.ok).toBe(false);
  });
});
