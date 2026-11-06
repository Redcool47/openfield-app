/**
 * Databases: collections, their properties, views, and per-page values.
 *
 * The tables for all of this already exist in the schema and were created with
 * the right indexes. What did not exist was any way to read or write them, which
 * is why the application could store a page and nothing else. This module is
 * that missing half.
 *
 * A property is stored as JSON inside `collection.schema_json` rather than as a
 * row of its own. That is a deliberate trade and worth stating, because the
 * obvious alternative is wrong: a property has no independent life. Renaming one
 * or changing its type has to rewrite every row that mentions it, and a
 * relational table would make that a migration. One JSON document makes a schema
 * change a single UPDATE, and the document is small by construction -- a handful
 * of columns per database. Values, which are large and numerous, are normalised
 * into `property_value` where they belong.
 */

import { newId } from '@ow/geom';
import type { Db } from './driver.js';

export type PropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'multiSelect'
  | 'date'
  | 'relation'
  /**
   * A local person.
   *
   * Local rather than an account, because there are no accounts. A person is a
   * name the workspace owner typed; the directory of them is theirs.
   */
  | 'person'
  /**
   * Files attached to a row.
   *
   * The value holds references, not bytes. The bytes live in the workspace's
   * assets folder, content-addressed, and the reference records which one.
   */
  | 'files';

export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  /** Select and multi-select options, in display order. */
  options?: { id: string; name: string; color: string }[];
}

export interface CollectionSchema {
  properties: Property[];
}

export interface Collection {
  id: string;
  name: string;
  schema: CollectionSchema;
  defaultView: string | null;
  parentPage: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ViewType = 'table' | 'board' | 'list' | 'calendar' | 'gallery';

export interface ViewRecord {
  id: string;
  collectionId: string;
  type: ViewType;
  name: string;
  config: Record<string, unknown>;
  position: string;
}

/** A property value, tagged so the renderer knows which cell to draw. */
export type PropertyValue =
  | { type: 'text'; text: string }
  | { type: 'number'; number: number | null }
  | { type: 'checkbox'; checked: boolean }
  | { type: 'select'; optionId: string | null }
  | { type: 'multiSelect'; optionIds: string[] }
  | { type: 'date'; date: string | null }
  | { type: 'relation'; pageIds: string[] }
  /** A local person, by id into the workspace's people directory. */
  | { type: 'person'; personIds: string[] }
  /** Files attached to the row, by content hash into the workspace's assets. */
  | { type: 'files'; files: { sha256: string; name: string; mime: string; size: number }[] };

function parseSchema(json: string): CollectionSchema {
  try {
    const parsed = JSON.parse(json) as Partial<CollectionSchema>;
    // Defensive: a database whose schema is corrupt should show as empty rather
    // than take the whole page down with it. Reading is best-effort; writing is
    // where validation belongs.
    return { properties: Array.isArray(parsed.properties) ? parsed.properties : [] };
  } catch {
    return { properties: [] };
  }
}

function rowToCollection(row: Record<string, unknown>): Collection {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    schema: parseSchema(String(row.schema_json ?? '{}')),
    defaultView: row.default_view === null ? null : String(row.default_view),
    parentPage: row.parent_page === null ? null : String(row.parent_page),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export class Databases {
  // Declared as a field rather than a `constructor(private readonly db: Db)`
  // parameter property. The CLI runs TypeScript sources directly through Node's
  // type stripping, which does not support parameter properties, and the failure
  // is a runtime SyntaxError on the first import rather than a type error.
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // ------------------------------------------------------------- collections

  createCollection(input: {
    id?: string;
    name?: string;
    parentPage?: string | null;
    properties?: Property[];
  }): string {
    const now = Date.now();
    const id = input.id ?? newId(now);
    const schema: CollectionSchema = { properties: input.properties ?? [] };
    this.db
      .prepare(
        `INSERT INTO collection (id, name, schema_json, default_view, parent_page, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(id, input.name ?? '', JSON.stringify(schema), input.parentPage ?? null, now, now);
    return id;
  }

  getCollection(id: string): Collection | null {
    const row = this.db.prepare('SELECT * FROM collection WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToCollection(row) : null;
  }

  listCollections(parentPage?: string | null): Collection[] {
    const rows =
      parentPage === undefined
        ? (this.db.prepare('SELECT * FROM collection ORDER BY created_at').all() as Record<string, unknown>[])
        : (this.db
            .prepare('SELECT * FROM collection WHERE parent_page IS ? ORDER BY created_at')
            .all(parentPage) as Record<string, unknown>[]);
    return rows.map(rowToCollection);
  }

  deleteCollection(id: string): void {
    this.db.prepare('DELETE FROM collection WHERE id = ?').run(id);
  }

  // --------------------------------------------------------------- properties

  /** Replace the whole property list. Atomic: a caller never sees a half schema. */
  setProperties(collectionId: string, properties: Property[]): void {
    this.db
      .prepare('UPDATE collection SET schema_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ properties }), Date.now(), collectionId);
  }

  addProperty(collectionId: string, property: Property): Property[] {
    const collection = this.getCollection(collectionId);
    if (!collection) throw new Error(`no such collection: ${collectionId}`);
    const next = [...collection.schema.properties, property];
    this.setProperties(collectionId, next);
    return next;
  }

  updateProperty(
    collectionId: string,
    propertyId: string,
    patch: Partial<Omit<Property, 'id'>>,
  ): Property[] {
    const collection = this.getCollection(collectionId);
    if (!collection) throw new Error(`no such collection: ${collectionId}`);
    const next = collection.schema.properties.map((p) =>
      p.id === propertyId ? { ...p, ...patch } : p,
    );
    this.setProperties(collectionId, next);
    return next;
  }

  // ------------------------------------------------------------------- values

  setValue(pageId: string, propertyId: string, value: PropertyValue | null): void {
    if (value === null) {
      this.db
        .prepare('DELETE FROM property_value WHERE page_id = ? AND property_id = ?')
        .run(pageId, propertyId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO property_value (page_id, property_id, value_json) VALUES (?, ?, ?)
         ON CONFLICT (page_id, property_id) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(pageId, propertyId, JSON.stringify(value));
  }

  getValue(pageId: string, propertyId: string): PropertyValue | null {
    const row = this.db
      .prepare('SELECT value_json FROM property_value WHERE page_id = ? AND property_id = ?')
      .get(pageId, propertyId) as { value_json?: string } | undefined;
    if (!row?.value_json) return null;
    try {
      return JSON.parse(row.value_json) as PropertyValue;
    } catch {
      return null;
    }
  }

  /**
   * Every property value for one page, keyed by property id.
   *
   * One query rather than one per column. A table with twenty columns would
   * otherwise issue twenty round trips per row to draw a single screen, which is
   * the sort of thing that makes an interface feel slow for no visible reason.
   */
  valuesForPage(pageId: string): Map<string, PropertyValue> {
    const rows = this.db
      .prepare('SELECT property_id, value_json FROM property_value WHERE page_id = ?')
      .all(pageId) as { property_id: string; value_json: string }[];
    const out = new Map<string, PropertyValue>();
    for (const row of rows) {
      try {
        out.set(row.property_id, JSON.parse(row.value_json) as PropertyValue);
      } catch {
        // A row that will not parse is skipped rather than failing the page.
      }
    }
    return out;
  }

  // -------------------------------------------------------------------- views

  addView(input: {
    id?: string;
    collectionId: string;
    type?: ViewType;
    name?: string;
    config?: Record<string, unknown>;
  }): string {
    const now = Date.now();
    const id = input.id ?? newId(now);
    const count = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM view WHERE collection_id = ?')
        .get(input.collectionId) as { n: number }
    ).n;
    this.db
      .prepare(
        `INSERT INTO view (id, collection_id, type, name, config_json, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.collectionId,
        input.type ?? 'table',
        input.name ?? '',
        JSON.stringify(input.config ?? {}),
        positionKey(count),
        now,
        now,
      );
    return id;
  }

  listViews(collectionId: string): ViewRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM view WHERE collection_id = ? ORDER BY position')
      .all(collectionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      collectionId: String(row.collection_id),
      type: String(row.type) as ViewType,
      name: String(row.name ?? ''),
      config: JSON.parse(String(row.config_json ?? '{}')) as Record<string, unknown>,
      position: String(row.position ?? ''),
    }));
  }

  deleteView(id: string): void {
    this.db.prepare('DELETE FROM view WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------- rows

  /**
   * Pages that belong to a collection, with their property values attached.
   *
   * Membership is `collection.parent_page`, matching how pages nest elsewhere in
   * this application: a database is a container and its rows are its children.
   * That keeps one ordering mechanism in the whole document instead of a second
   * one that could disagree with the first.
   */
  rows(collectionId: string): { page: { id: string; title: string }; values: Map<string, PropertyValue> }[] {
    const collection = this.getCollection(collectionId);
    if (!collection) return [];
    const pages = this.db
      .prepare(
        `SELECT id, title FROM page WHERE parent_page = ? AND trashed_at IS NULL ORDER BY position`,
      )
      .all(collection.parentPage) as { id: string; title: string }[];
    return pages.map((page) => ({ page, values: this.valuesForPage(page.id) }));
  }

  /**
   * The collection this page is a row of, if any.
   *
   * A row is simply a child of the page that hosts the collection, so the join
   * is direct. This question had no way to be asked before: `listCollections(
   * pageId)` answers whether a page *hosts* a collection and says nothing about
   * whether it is a row in one, so a row page was indistinguishable from an
   * ordinary document with no properties -- which is why the properties area
   * could not be built on top of it.
   */
  collectionOfRow(pageId: string): Collection | null {
    const row = this.db
      .prepare(
        `SELECT c.id FROM collection c
         JOIN page child ON child.parent_page = c.parent_page
         WHERE child.id = ? AND child.trashed_at IS NULL
         LIMIT 1`,
      )
      .get(pageId) as { id?: string } | undefined;
    return row?.id ? this.getCollection(row.id) : null;
  }
}

/**
 * A short sort key for the nth item.
 *
 * The same shape as page ordering: increment the last character. With tens of
 * views per database this never needs to grow, and it keeps `ORDER BY position`
 * doing a string compare rather than a numeric cast on every read.
 */
function positionKey(index: number): string {
  return 'a' + String.fromCharCode(97 + (index % 26)) + Math.floor(index / 26);
}

