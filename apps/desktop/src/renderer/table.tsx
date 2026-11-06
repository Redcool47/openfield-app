/**
 * The database table view.
 *
 * Reads a collection and its values and draws a grid. Two rules hold throughout:
 *
 *   - The component never writes to the document. Every edit is a command, so
 *     the same code path serves the mouse, the keyboard map and the CLI.
 *   - A value carries its own type tag, so each cell knows what to draw without
 *     consulting the schema. That is why values are a union rather than JSON:
 *     { type: 'select', optionId } can render a pill, and a bare string cannot.
 *
 * Filtering and sorting are applied by re-reading through `db.rows` rather than
 * by arranging the rows already in hand. The query layer in `@ow/commands`
 * already implements this and is unit-tested against the cases that are awkward
 * to reproduce by eye -- a number column sorted as strings, empties landing on
 * top of a descending sort -- and a second implementation here would only be a
 * second place for those to be wrong.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FILTER_LABELS, filterOpsFor, type FilterOp, type SortRule } from '@ow/commands/view-query';
import { Icon, type IconName } from '@ow/ui-kit';

export interface DbProperty {
  id: string;
  name: string;
  type: string;
  options?: { id: string; name: string; color: string }[];
}

export interface DbValue {
  type: string;
  text?: string;
  number?: number | null;
  checked?: boolean;
  date?: string | null;
  optionId?: string | null;
  optionIds?: string[];
  pageIds?: string[];
  personIds?: string[];
  files?: { sha256: string; name: string; mime: string; size: number }[];
}

export interface DbRow {
  id: string;
  title: string;
  values: Record<string, unknown>;
}

export interface DbState {
  collection: { id: string; name: string; schema: { properties: DbProperty[] } };
  views: { id: string; type: string; name: string }[];
  rows: DbRow[];
}

type Run = (id: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: string }>;

/** The icon shown in each column header, matching the reference's type glyphs. */
const TYPE_ICON: Record<string, IconName> = {
  text: 'text',
  number: 'equation',
  select: 'todo',
  multiSelect: 'bookmark',
  date: 'date',
  checkbox: 'todo',
  relation: 'link',
};

/**
 * Render a date the way the reference does.
 *
 * "March 8, 2027", not "2027-03-08". The value is stored as an ISO string because
 * that is what sorts correctly and round-trips; it is only humanised here, at
 * the moment of display, so no locale decision leaks into storage.
 */
function humanDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * The filter operators that need no value.
 *
 * `contains` and `is` take one and the bar has no input for it. Offering them
 * anyway made a text filter match every row and a number or select filter blank
 * the table -- a control that looked live and did the wrong thing. Removing the
 * operators fixes it; adding a value input would be a feature nobody asked for.
 *
 * shortcut: value-taking operators (`is`, `gt`, `lt`, `contains`) come back when
 * there is a value input per property type. Until then they are not offered,
 * rather than offered broken.
 */
const NO_VALUE_OPS: FilterOp[] = ['empty', 'notEmpty', 'checked', 'unchecked'];

export function DatabaseTable({ db, run, onOpenPage, people = {} }: {
  db: DbState;
  run: Run;
  onOpenPage: (id: string) => void;
  /** The workspace's people directory, for rendering person properties by name. */
  people?: Record<string, { id: string; name: string }>;
}) {
  const [activeView, setActiveView] = useState(db.views[0]?.id ?? '');
  const [busyCell, setBusyCell] = useState<string | null>(null);

  /**
   * The active query, and the rows it produced.
   *
   * `rows` starts as whatever the parent handed over and is replaced by the result
   * of `db.rows` whenever the query changes. Re-reading rather than sorting the
   * array in place keeps one implementation of "what a filter means" -- the
   * command's -- instead of two that can disagree.
   */
  const [sorts, setSorts] = useState<SortRule[]>([]);
  const [filterProperty, setFilterProperty] = useState<string>('');
  const [filterOp, setFilterOp] = useState<FilterOp>('notEmpty');
  const [rows, setRows] = useState<DbRow[]>(db.rows);
  const [total, setTotal] = useState(db.rows.length);

  const refresh = useCallback(
    async (nextSorts: SortRule[], propertyId: string, op: FilterOp) => {
      const result = await run('db.rows', {
        collectionId: db.collection.id,
        sorts: nextSorts,
        filters: propertyId ? [{ propertyId, op, value: '' }] : [],
      });
      if (!result.ok) return;
      const value = result.value as { rows: DbRow[]; total: number };
      setRows(value.rows);
      setTotal(value.total);
    },
    [run, db.collection.id],
  );

  // A different database means a different query. Carrying a filter keyed on the
  // previous collection's property id would silently filter nothing, which reads
  // as "the filter is broken" rather than "it belongs to another table".
  useEffect(() => {
    setSorts([]);
    setFilterProperty('');
    setRows(db.rows);
    setTotal(db.rows.length);
  // Keyed on the collection id for the reset. The separate effect below picks up
  // rows added while the table is open; keying this one on `db.rows` as well
  // wiped the user's sort and filter on every state push.
  }, [db.collection.id]);

  // A row added from any control has to appear in the table that added it.
  // `rows` is local because a query replaces it, so it is not enough for the
  // parent to hand over a new `db.rows`: nothing copies it in. The count is
  // compared against the last one seen rather than to `total`, because a filter
  // makes those two legitimately differ.
  const lastCount = useRef(db.rows.length);
  useEffect(() => {
    if (lastCount.current === db.rows.length) return;
    lastCount.current = db.rows.length;
    void refresh(sorts, filterProperty, filterOp);
  }, [db.rows.length, refresh, sorts, filterProperty, filterOp]);

  const properties = db.collection.schema.properties;
  const view = db.views.find((v) => v.id === activeView) ?? db.views[0];

  // The first property doubles as the row title in the reference, so it is not
  // drawn as a column of its own -- showing the page name twice is noise.
  const columns = useMemo(() => {
    const [first, ...rest] = properties;
    return first ? rest : properties;
  }, [properties]);

  const titleProperty = properties[0];

  /**
   * Columns the user has hidden.
   *
   * Local state rather than part of the schema: hiding a column is a way of
   * looking at the data, not a change to it, and two people looking at the same
   * database should not have the same set of columns forced on them.
   */
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([]);
  const toggleColumn = useCallback((id: string) => {
    setHiddenColumns((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  }, []);
  const hidden = useMemo(
    () => columns.filter((p) => hiddenColumns.includes(p.id)),
    [columns, hiddenColumns],
  );
  const shown = useMemo(
    () => columns.filter((p) => !hiddenColumns.includes(p.id)),
    [columns, hiddenColumns],
  );

  const valueOf = (row: DbRow, propertyId: string): DbValue | null =>
    (row.values[propertyId] as DbValue | undefined) ?? null;

  return (
    <div className="ow-db">
      <div className="ow-db-title">{db.collection.name}</div>

      <div className="ow-db-views">
        {db.views.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`ow-db-view${v.id === view?.id ? ' is-active' : ''}`}
            onClick={() => setActiveView(v.id)}
          >
            <Icon name={v.type === 'board' ? 'todo' : 'bulletedList'} size={14} />
            {v.name || 'Untitled'}
          </button>
        ))}
      </div>

      {/* Query controls. A sort and a filter, because those are the two the
          command layer actually implements -- offering grouping here as well
          would mean wiring a board, and a control that does nothing is worse
          than a missing one. */}
      <div className="ow-db-query">
        <label className="ow-db-query-field">
          <span className="ow-sr-only">Sort by</span>
          <select
            value={sorts[0]?.propertyId ?? ''}
            onChange={(e) => {
              const id = e.target.value;
              const next: SortRule[] = id ? [{ propertyId: id, descending: sorts[0]?.descending ?? false }] : [];
              setSorts(next);
              void refresh(next, filterProperty, filterOp);
            }}
          >
            <option value="">No sort</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        {sorts.length > 0 && (
          <button
            type="button"
            className="ow-db-query-btn"
            aria-pressed={sorts[0]?.descending === true}
            onClick={() => {
              const next: SortRule[] = [{ ...sorts[0]!, descending: !sorts[0]!.descending }];
              setSorts(next);
              void refresh(next, filterProperty, filterOp);
            }}
          >
            {sorts[0]?.descending ? 'Descending' : 'Ascending'}
          </button>
        )}

        <label className="ow-db-query-field">
          <span className="ow-sr-only">Filter</span>
          <select
            value={filterProperty}
            onChange={(e) => {
              const id = e.target.value;
              setFilterProperty(id);
              const type = properties.find((p) => p.id === id)?.type ?? 'text';
              const op = filterOpsFor(type).find((o) => NO_VALUE_OPS.includes(o)) ?? 'notEmpty';
              setFilterOp(op);
              void refresh(sorts, id, op);
            }}
          >
            <option value="">No filter</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        {filterProperty !== '' && (
          <label className="ow-db-query-field">
            <span className="ow-sr-only">Filter condition</span>
            <select
              value={filterOp}
              onChange={(e) => {
                const op = e.target.value as FilterOp;
                setFilterOp(op);
                void refresh(sorts, filterProperty, op);
              }}
            >
              {filterOpsFor(properties.find((p) => p.id === filterProperty)?.type ?? 'text')
              .filter((op) => NO_VALUE_OPS.includes(op))
              .map((op) => (
                <option key={op} value={op}>
                  {FILTER_LABELS[op]}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* The count is the only way a user learns a filter is hiding something.
            Without it, an empty table is indistinguishable from an empty database. */}
        {rows.length !== total && (
          <span className="ow-db-query-count">
            {rows.length} of {total}
          </span>
        )}
      </div>

      {view?.type === 'board' ? (
        <Board db={db} rows={rows} run={run} onOpenPage={onOpenPage} />
      ) : view?.type === 'list' ? (
        <ListView db={db} rows={rows} onOpenPage={onOpenPage} />
      ) : view?.type === 'gallery' ? (
        <Gallery db={db} rows={rows} onOpenPage={onOpenPage} />
      ) : (
        <>
      <div className="ow-db-table" role="table" aria-label={db.collection.name}>
        <div className="ow-db-row ow-db-head" role="row">
          <div className="ow-db-cell ow-db-cell--title" role="columnheader">
            <Icon name={TYPE_ICON[titleProperty?.type ?? 'text'] ?? 'text'} size={14} />
            {titleProperty?.name ?? 'Name'}
          </div>
          {shown.map((property) => (
            <div key={property.id} className="ow-db-cell ow-db-cell--hidable" role="columnheader">
              <Icon name={TYPE_ICON[property.type] ?? 'text'} size={14} />
              {property.name}
              {/* Hide sits on the header rather than in a separate settings menu:
                  the only place a column is ever needed is next to its own name,
                  and a menu of column names is one more list to keep in sync. */}
              <button
                type="button"
                className="ow-db-hide"
                aria-label={`Hide ${property.name}`}
                onClick={() => toggleColumn(property.id)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>

        {/* Restoring has to be possible from the table itself, or hiding a
            column is irreversible without going and editing the schema. */}
        {hidden.length > 0 && (
          <div className="ow-db-columns" role="group" aria-label="Hidden columns">
            <span className="ow-db-columns-label">Show</span>
            {hidden.map((property) => (
              <button
                key={property.id}
                type="button"
                className="ow-db-columns-add"
                onClick={() => toggleColumn(property.id)}
              >
                <Icon name="plus" size={12} />
                {property.name}
              </button>
            ))}
          </div>
        )}

        {rows.map((row) => (
          <div key={row.id} className="ow-db-row" role="row">
            <div
              className="ow-db-cell ow-db-cell--title"
              role="cell"
              tabIndex={0}
              onClick={() => onOpenPage(row.id)}
              onKeyDown={(e) => {
                // Only the cell's own keys. The title input is a child, and
                // without this a space in a row title bubbled up here and
                // navigated to the row page mid-word.
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenPage(row.id);
                }
              }}
            >
              <Icon name="page" size={14} />
              <input
                className="ow-db-title-input"
                defaultValue={row.title}
                aria-label={`Title of ${row.title || 'new row'}`}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const next = e.currentTarget.value;
                  if (next === row.title) return;
                  void run('page.rename', { id: row.id, title: next });
                }}
              />
            </div>

            {shown.map((property) => (
              <div key={property.id} className="ow-db-cell" role="cell">
                <Cell
                  property={property}
                  value={valueOf(row, property.id)}
                  collectionId={db.collection.id}
                  pageId={row.id}
                  busy={busyCell === `${row.id}:${property.id}`}
                  onBusy={(k) => setBusyCell(k)}
                  run={run}
                  people={people}
                />
              </div>
            ))}
          </div>
        ))}

        <div className="ow-db-row ow-db-add" role="row">
          <button
            type="button"
            className="ow-db-add-btn"
            onClick={() =>
              void run('db.row.add', { collectionId: db.collection.id, title: '' })
            }
          >
            <Icon name="plus" size={14} />
            New page
          </button>
        </div>
      </div>
        </>
      )}
    </div>
  );
}

/**
 * The board view: rows grouped into columns by a select property.
 *
 * Grouping picks the first select property, which is the only sensible default
 * available -- a board grouped by a date or a number is not a board, and there
 * is no picker yet to choose otherwise. When the grouping property is missing
 * or has no options the board says so instead of rendering an empty grid, which
 * would look like a bug in the data rather than an absent configuration.
 */
/**
 * A row's value for a property, or null when unset.
 *
 * Module level rather than a closure inside DatabaseTable, because the list and
 * gallery views need the same rule and three copies of "missing means null" is
 * how one of them starts rendering the string "undefined".
 */
const rowValue = (row: DbRow, propertyId: string): DbValue | null =>
  (row.values[propertyId] as DbValue | undefined) ?? null;

/**
 * List view: one line per row, only the properties that have a value.
 *
 * Dense on purpose -- it is the view for scanning many rows, not for reading
 * one. Empty cells are skipped rather than shown blank, because a row with two
 * of five columns filled should read as two columns, not as five with noise.
 */
function ListView({ db, rows, onOpenPage }: { db: DbState; rows: DbRow[]; onOpenPage: (id: string) => void }) {
  const properties = db.collection.schema.properties;
  const [first, ...rest] = properties;

  return (
    <div className="ow-list" role="list" aria-label={`${db.collection.name} list`}>
      {rows.map((row) => {
        const shown = rest.filter((p) => rowValue(row, p.id) !== null);
        return (
          <button
            key={row.id}
            type="button"
            role="listitem"
            className="ow-list-row"
            onClick={() => onOpenPage(row.id)}
          >
            <span className="ow-list-title">{row.title || 'Untitled'}</span>
            {shown.map((p) => (
              <span className="ow-list-cell" key={p.id}>
                <Icon name={TYPE_ICON[p.type] ?? 'text'} size={12} />
                {String(rowValue(row, p.id) ?? '')}
              </span>
            ))}
            {shown.length === 0 && <span className="ow-list-cell ow-list-cell--empty">—</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Gallery view: a grid of cards, each showing a property preview.
 *
 * The first non-title property with a value becomes the card's cover, because a
 * gallery whose cards are all identical blocks communicates nothing. Colour for
 * select and status properties is drawn as a chip so a board scanned at a
 * distance still reads.
 */
function Gallery({ db, rows, onOpenPage }: { db: DbState; rows: DbRow[]; onOpenPage: (id: string) => void }) {
  const properties = db.collection.schema.properties;
  const [first, ...rest] = properties;
  const preview = rest.find((p) => p.type === 'select' || p.type === 'date' || p.type === 'text');

  return (
    <div className="ow-gallery" aria-label={`${db.collection.name} gallery`}>
      {rows.map((row) => {
        const value = preview ? rowValue(row, preview.id) : null;
        return (
          <button key={row.id} type="button" className="ow-card" onClick={() => onOpenPage(row.id)}>
            <span className="ow-card-cover" data-empty={value === null ? 'true' : undefined}>
              {value === null ? '' : String(value)}
            </span>
            <span className="ow-card-body">
              <span className="ow-card-title">{row.title || 'Untitled'}</span>
              {rest.slice(0, 2).map((p) =>
                rowValue(row, p.id) === null ? null : (
                  <span className="ow-card-field" key={p.id}>
                    {p.name}: {String(rowValue(row, p.id))}
                  </span>
                ),
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Board({ db, rows, run, onOpenPage }: {
  db: DbState;
  /** The queried rows, not `db.rows`: the board was showing the unfiltered list. */
  rows: DbRow[];
  run: Run;
  onOpenPage: (id: string) => void;
  /** The workspace's people directory, for rendering person properties by name. */
  people?: Record<string, { id: string; name: string }>;
}) {
  const groupProperty = db.collection.schema.properties.find((p) => p.type === 'select');

  if (!groupProperty || !groupProperty.options || groupProperty.options.length === 0) {
    return (
      <div className="ow-board ow-board--empty">
        A board groups rows by a select property. Add one to this database to use it.
      </div>
    );
  }

  const byOption = new Map<string, DbRow[]>();
  for (const option of groupProperty.options) byOption.set(option.id, []);
  const ungrouped: DbRow[] = [];
  for (const row of rows) {
    const id = (row.values[groupProperty.id] as DbValue | undefined)?.optionId;
    const bucket = id ? byOption.get(id) : undefined;
    if (bucket) bucket.push(row);
    else ungrouped.push(row);
  }

  // The properties worth showing on a card: whatever is not the grouping
  // property and not the row title. Showing the title twice on a card is noise.
  const cardProperties = db.collection.schema.properties.filter(
    (p) => p.id !== groupProperty.id && db.collection.schema.properties[0]?.id !== p.id,
  );

  const column = (optionId: string, optionName: string, color: string, rows: DbRow[]) => (
    <div key={optionId} className="ow-board-col">
      <div className="ow-board-head">
        <span className="ow-board-dot" style={{ background: color }} />
        {optionName}
        <span className="ow-board-count">{rows.length}</span>
      </div>
      <div className="ow-board-cards">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className="ow-board-card"
            onClick={() => onOpenPage(row.id)}
          >
            <span className="ow-board-card-title">{row.title || 'Untitled'}</span>
            {cardProperties.map((property) => (
              <CardField key={property.id} property={property} value={(row.values[property.id] as DbValue) ?? null} />
            ))}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="ow-board">
      {groupProperty.options.map((option) =>
        column(option.id, option.name, option.color, byOption.get(option.id) ?? []),
      )}
      {ungrouped.length > 0 && column('__none', 'No status', '#9b9b9b', ungrouped)}
    </div>
  );
}

/** One property rendered on a board card. Read-only: a card is a summary. */
function CardField({ property, value }: { property: DbProperty; value: DbValue | null }) {
  if (!value) return null;
  switch (property.type) {
    case 'checkbox':
      return value.checked ? <span className="ow-board-field">Done</span> : null;
    case 'date':
      return value.date ? (
        <span className="ow-board-field">{humanDate(value.date)}</span>
      ) : null;
    case 'number':
      return value.number === null || value.number === undefined ? null : (
        <span className="ow-board-field">{value.number}</span>
      );
    case 'select': {
      const option = property.options?.find((o) => o.id === value.optionId);
      if (!option) return null;
      return (
        <span className="ow-db-pill" style={{ background: `${option.color}26`, color: option.color }}>
          {option.name}
        </span>
      );
    }
    case 'text':
      return value.text ? <span className="ow-board-field">{value.text}</span> : null;
    default:
      return null;
  }
}

/**
 * One property cell.
 *
 * Editable for the types where editing is unambiguous -- a checkbox ticks, a
 * select cycles or opens, a number and a date accept typed input. Read-only for
 * the rest, because "relation" and "multiSelect" need a picker that does not
 * exist yet and a fake control would be worse than an honest blank.
 */
export function Cell({ property, value, collectionId, pageId, busy, onBusy, run, people = {} }: {
  property: DbProperty;
  value: DbValue | null;
  collectionId: string;
  pageId: string;
  busy: boolean;
  onBusy: (key: string | null) => void;
  run: Run;
  /** The workspace's people directory, for rendering person properties by name. */
  people?: Record<string, { id: string; name: string }>;
}) {
  const set = async (raw: unknown) => {
    const key = `${pageId}:${property.id}`;
    onBusy(key);
    await run('db.value.set', {
      collectionId,
      pageId,
      propertyId: property.id,
      value: raw,
    });
    onBusy(null);
  };

  switch (property.type) {
    case 'checkbox':
      return (
        <input
          type="checkbox"
          className="ow-db-check"
          checked={value?.checked === true}
          aria-label={property.name}
          onChange={(e) => void set(e.currentTarget.checked)}
        />
      );

    case 'select': {
      const option = property.options?.find((o) => o.id === value?.optionId);
      if (!option) return <span className="ow-db-empty" />;
      return (
        <span
          className="ow-db-pill"
          style={{ background: `${option.color}26`, color: option.color }}
          title={option.name}
        >
          {option.name}
        </span>
      );
    }

    case 'multiSelect': {
      const ids = value?.optionIds ?? [];
      if (ids.length === 0) return <span className="ow-db-empty" />;
      return (
        <span className="ow-db-pills">
          {ids.map((id) => {
            const option = property.options?.find((o) => o.id === id);
            if (!option) return null;
            return (
              <span
                key={id}
                className="ow-db-pill"
                style={{ background: `${option.color}26`, color: option.color }}
              >
                {option.name}
              </span>
            );
          })}
        </span>
      );
    }

    case 'date': {
      const iso = value?.date;
      return (
        <span className="ow-db-date" title={iso ?? ''}>
          {iso ? humanDate(iso) : ''}
        </span>
      );
    }

    case 'number': {
      const n = value?.number;
      return (
        <input
          type="number"
          className="ow-db-number"
          defaultValue={n ?? ''}
          aria-label={property.name}
          disabled={busy}
          onBlur={(e) => {
            const raw = e.currentTarget.value;
            const next = raw === '' ? null : Number(raw);
            if (Number.isFinite(next) && next === n) return;
            void set(next);
          }}
        />
      );
    }

    case 'relation': {
      const pages = value?.pageIds ?? [];
      return <span className="ow-db-empty">{pages.length === 0 ? '' : `${pages.length} linked`}</span>;
    }

    case 'person': {
      const ids = value?.personIds ?? [];
      if (ids.length === 0) return <span className="ow-db-empty" />;
      // Names, not ids. The id is the storage detail; the name is what the
      // reader needs, and a row of hashes tells nobody anything.
      return (
        <span className="ow-db-people">
          {ids.map((id) => (
            <span className="ow-db-person" key={id} title={id}>
              {people[id]?.name ?? id}
            </span>
          ))}
        </span>
      );
    }

    case 'files': {
      const files = value?.files ?? [];
      if (files.length === 0) return <span className="ow-db-empty" />;
      return (
        <span className="ow-db-files">
          {files.map((f: { sha256: string; name: string; mime: string; size: number }) => (
            <span className="ow-db-file" key={f.sha256} title={`${f.mime} · ${f.size} bytes`}>
              <Icon name="file" size={12} />
              {f.name}
            </span>
          ))}
        </span>
      );
    }

    case 'text':
    default:
      return <span className="ow-db-text">{value?.text ?? ''}</span>;
  }
}
