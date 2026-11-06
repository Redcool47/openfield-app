/**
 * Database commands.
 *
 * Everything a database can be asked to do, as a named command. The rule the
 * project runs on is that no user-visible action exists outside this list, so
 * without these commands the database tables in the schema would be readable
 * only by writing SQL by hand.
 *
 * Values are typed rather than opaque JSON. A renderer that receives
 * `{ type: 'select', optionId: 'x' }` knows which cell to draw; one that
 * receives `'x'` has to guess. The tag is the whole reason this is a union
 * rather than `unknown`.
 */

import type { Command, CommandContext } from './registry.js';
import type { Property, PropertyType, PropertyValue, ViewType } from '@ow/storage';
import type { Session } from './session.js';
import { runQuery, type FilterRule, type SortRule } from './view-query.js';
import { newId } from '@ow/geom';

/**
 * The registry types `session` as unknown so that nothing can depend on the
 * session's shape by accident. The real type is recovered here once, explicitly,
 * the same way builtin.ts does it -- rather than by widening the context type,
 * which would make every command able to assume a session that may not be there.
 */
type Ctx = CommandContext & { session: Session };
const ctxOf = (ctx: CommandContext): Ctx => ctx as Ctx;

const PROPERTY_TYPES: PropertyType[] = [
  'text',
  'number',
  'checkbox',
  'select',
  'multiSelect',
  'date',
  'relation',
  'person',
  'files',
];

/** Options a select property starts with. Colours match the reference palette. */
const DEFAULT_OPTIONS = [
  { id: 'opt-todo', name: 'To do', color: '#9b9b9b' },
  { id: 'opt-progress', name: 'In progress', color: '#2f6fed' },
  { id: 'opt-blocked', name: 'Blocked', color: '#e06c5c' },
  { id: 'opt-done', name: 'Done', color: '#4a9d6f' },
];

/**
 * Coerce an argument into a typed property value.
 *
 * Validation lives here rather than in the renderer, so that the CLI, the tests
 * and the UI cannot disagree about what a value is. A command that accepted
 * anything would make the database's contents depend on who wrote them.
 */
function coerceValue(type: PropertyType, raw: unknown): PropertyValue {
  switch (type) {
    case 'checkbox':
      return { type: 'checkbox', checked: raw === true };
    case 'number': {
      // Empty means empty. Number(null) and Number('') are both 0, so an unset
      // number would be stored as a real zero and every column would show a row
      // of zeros where the user had entered nothing.
      if (raw === null || raw === undefined || raw === '') {
        return { type: 'number', number: null };
      }
      const n = typeof raw === 'number' ? raw : Number(raw);
      return { type: 'number', number: Number.isFinite(n) ? n : null };
    }
    case 'date':
      return { type: 'date', date: typeof raw === 'string' && raw ? raw : null };
    case 'select':
      return { type: 'select', optionId: typeof raw === 'string' && raw ? raw : null };
    case 'multiSelect':
      return {
        type: 'multiSelect',
        optionIds: Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [],
      };
    case 'relation':
      return {
        type: 'relation',
        pageIds: Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [],
      };
    case 'person':
      // A list of ids into the workspace's people directory. Anything that is not
      // a string is dropped rather than stringified: a number that became "3"
      // would name a person called "3".
      return {
        type: 'person',
        personIds: Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [],
      };
    case 'files':
      // References, not bytes. The bytes live in the workspace's assets folder
      // and the reference says which one.
      return {
        type: 'files',
        files: Array.isArray(raw)
          ? raw.filter(
              (v): v is { sha256: string; name: string; mime: string; size: number } =>
                typeof v === 'object' &&
                v !== null &&
                typeof (v as { sha256?: unknown }).sha256 === 'string',
            )
          : [],
      };
    case 'text':
    default:
      return { type: 'text', text: typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : String(raw) };
  }
}

/** Reject a property definition the renderer cannot draw. */
function validateProperty(input: { id?: unknown; name?: unknown; type?: unknown }): Property {
  const type = String(input.type ?? 'text') as PropertyType;
  if (!PROPERTY_TYPES.includes(type)) {
    throw new Error(`unknown property type "${type}" (expected one of ${PROPERTY_TYPES.join(', ')})`);
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled';
  const id = typeof input.id === 'string' && input.id ? input.id : propId(name);
  return {
    id,
    name,
    type,
    ...(type === 'select' || type === 'multiSelect' ? { options: DEFAULT_OPTIONS } : {}),
  };
}

/** A stable, readable property id derived from its name. */
function propId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `prop-${slug || 'field'}`;
}

export const DB_COMMANDS: Command[] = [
  {
    id: 'db.create',
    title: 'Create database',
    category: 'Database',
    args: {
      name: { type: 'string', default: 'Database' },
      pageId: { type: 'string' },
    },
    run: (ctx) => {
      const repo = ctxOf(ctx).session.repo;
      let pageId = ctx.args.pageId as string | undefined;
      // A database is a page that holds rows, so it gets its own page to live in.
      // Creating one implicitly rather than requiring the caller to make a page
      // first is what stops "database" and "page" drifting into two concepts.
      if (!pageId) pageId = repo.createPage({ title: (ctx.args.name as string) ?? 'Database' });
      const id = repo.databases.createCollection({
        name: (ctx.args.name as string) ?? 'Database',
        parentPage: pageId,
        properties: [
          { id: 'prop-name', name: 'Name', type: 'text' },
          { id: 'prop-status', name: 'Status', type: 'select', options: DEFAULT_OPTIONS },
        ],
      });
      const viewId = repo.databases.addView({ collectionId: id, type: 'table', name: 'All' });
      return { id, pageId, viewId };
    },
  },
  {
    id: 'db.list',
    title: 'List databases on a page',
    category: 'Database',
    args: { pageId: { type: 'string' } },
    run: (ctx) => {
      const session = ctxOf(ctx).session;
      // The session's open page, not ctx.pageId(name) -- that one resolves a
      // page *by name*, which is a different question and wants an argument.
      const pageId = (ctx.args.pageId as string) ?? session.pageId;
      if (!pageId) throw new Error('no page is open');
      return session.repo.databases.listCollections(pageId);
    },
  },
  {
    id: 'db.people.list',
    title: 'List the workspace people',
    category: 'Database',
    run: (ctx) => ({ people: ctxOf(ctx).session.repo.people() }),
  },
  {
    id: 'db.people.add',
    title: 'Add a person to the workspace directory',
    category: 'Database',
    args: { name: { type: 'string', required: true } },
    run: (ctx) => {
      const repo = ctxOf(ctx).session.repo;
      const name = String(ctx.args.name ?? '').trim();
      if (!name) throw new Error('db.people.add: a person needs a name');
      const people = repo.people();
      // Same name, same person. Adding "Sam" twice should not produce two Sams
      // that a person property then has to choose between.
      const existing = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (existing) return { person: existing, created: false };
      const person = { id: `person-${newId()}`, name };
      repo.setPeople([...people, person]);
      return { person, created: true };
    },
  },
  {
    id: 'db.people.remove',
    title: 'Remove a person from the workspace directory',
    category: 'Database',
    args: { personId: { type: 'string', required: true } },
    run: (ctx) => {
      const repo = ctxOf(ctx).session.repo;
      const personId = String(ctx.args.personId ?? '');
      const people = repo.people();
      const next = people.filter((p) => p.id !== personId);
      if (next.length === people.length) throw new Error(`db.people.remove: no such person: ${personId}`);
      repo.setPeople(next);
      return { removed: personId, people: next };
    },
  },
  {
    id: 'db.property.add',
    title: 'Add a property to a database',
    category: 'Database',
    args: { collectionId: { type: 'string', required: true }, id: { type: 'string' }, name: { type: 'string', required: true }, type: { type: 'string', default: 'text' } },
    run: (ctx) => {
      const properties = ctxOf(ctx).session.repo.databases.addProperty(
        ctx.args.collectionId as string,
        validateProperty(ctx.args),
      );
      return { properties };
    },
  },
  {
    id: 'db.property.rename',
    title: 'Rename or retype a property',
    category: 'Database',
    args: { collectionId: { type: 'string', required: true }, propertyId: { type: 'string', required: true }, name: { type: 'string' }, type: { type: 'string' } },
    run: (ctx) => {
      const collectionId = ctx.args.collectionId as string;
      const propertyId = ctx.args.propertyId as string;
      const existing = ctxOf(ctx).session.repo.databases
        .getCollection(collectionId)
        ?.schema.properties.find((p) => p.id === propertyId);
      if (!existing) throw new Error(`no such property: ${propertyId}`);
      const merged = validateProperty({
        id: propertyId,
        name: (ctx.args.name as string) ?? existing.name,
        // Changing type is refused unless asked for explicitly, so a rename
        // cannot silently retype a column and orphan every value in it.
        type: (ctx.args.type as string) ?? existing.type,
      });
      const properties = ctxOf(ctx).session.repo.databases.updateProperty(collectionId, propertyId, {
        name: merged.name,
        type: merged.type,
        ...(merged.options ? { options: merged.options } : {}),
      });
      return { properties };
    },
  },
  {
    id: 'db.value.set',
    title: 'Set a property value on a page',
    category: 'Database',
    args: {
      collectionId: { type: 'string', required: true },
      pageId: { type: 'string', required: true },
      propertyId: { type: 'string', required: true },
      value: { type: 'any', default: null },
    },
    run: (ctx) => {
      const repo = ctxOf(ctx).session.repo;
      const collectionId = ctx.args.collectionId as string;
      const pageId = ctx.args.pageId as string;
      const propertyId = ctx.args.propertyId as string;
      const property = repo.databases
        .getCollection(collectionId)
        ?.schema.properties.find((p) => p.id === propertyId);
      if (!property) throw new Error(`no such property: ${propertyId}`);
      const value = coerceValue(property.type, ctx.args.value);
      repo.databases.setValue(pageId, propertyId, value);
      return { pageId, propertyId, value };
    },
  },
  {
    id: 'db.rows',
    title: 'List a database with its values',
    category: 'Database',
    args: {
      collectionId: { type: 'string', required: true },
      filters: { type: 'any', default: null },
      sorts: { type: 'any', default: null },
    },
    run: (ctx) => {
      const repo = ctxOf(ctx).session.repo;
      const collectionId = ctx.args.collectionId as string;
      const collection = repo.databases.getCollection(collectionId);
      if (!collection) throw new Error(`no such collection: ${collectionId}`);
      const views = repo.databases.listViews(collectionId);

      // Every row carries its timestamps, because "created" and "updated" are
      // properties of every row whether or not the schema declares them, and a
      // table that cannot be sorted by when a page was last touched is missing
      // the first sort anyone tries.
      const rows = repo.databases.rows(collectionId).map(({ page, values }) => {
        const meta = repo.getPage(page.id);
        return {
          id: page.id,
          title: page.title,
          createdAt: meta?.created_at ?? 0,
          updatedAt: meta?.updated_at ?? 0,
          values: Object.fromEntries(values),
        };
      });

      const query = runQuery(rows, {
        filters: (ctx.args.filters as FilterRule[] | undefined) ?? [],
        sorts: (ctx.args.sorts as SortRule[] | undefined) ?? [],
      });

      return {
        collection,
        views,
        rows: query.rows,
        total: query.total,
      };
    },
  },
  {
    id: 'db.row.add',
    title: 'Add a row to a database',
    category: 'Database',
    args: { collectionId: { type: 'string', required: true }, title: { type: 'string', default: '' } },
    run: (ctx) => {
      const repo = ctxOf(ctx).session.repo;
      const collection = repo.databases.getCollection(ctx.args.collectionId as string);
      if (!collection) throw new Error(`no such collection: ${ctx.args.collectionId as string}`);
      const id = repo.createPage({
        title: (ctx.args.title as string) ?? '',
        parentPage: collection.parentPage,
      });
      return { id, collectionId: collection.id };
    },
  },
  {
    id: 'db.view.add',
    title: 'Add a view',
    category: 'Database',
    args: {
      collectionId: { type: 'string', required: true },
      type: { type: 'string', default: 'table' },
      name: { type: 'string', default: '' },
    },
    run: (ctx) => {
      const type = (ctx.args.type as string) as ViewType;
      const id = ctxOf(ctx).session.repo.databases.addView({
        collectionId: ctx.args.collectionId as string,
        type,
        name: (ctx.args.name as string) ?? '',
      });
      return { id };
    },
  },
];
