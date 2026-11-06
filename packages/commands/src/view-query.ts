/**
 * Filtering, sorting and grouping rows in a database view.
 *
 * Pure functions over an already-fetched view model. That placement is
 * deliberate: a view query needs no database access, no session and no side
 * effects, which makes the whole of it testable without a workspace and
 * re-usable by the CLI, the tests and the renderer alike. The alternative --
 * pushing it into the storage layer as SQL -- would make every filter
 * combination a hand-written statement and put the interesting logic where it
 * cannot be tested cheaply.
 *
 * The design follows one idea worth stealing from elsewhere: every row has three
 * pseudo-properties -- title, created and updated -- whether or not the schema
 * declares them. Without them a table cannot be sorted by when a page was last
 * touched, which is one of the first things anyone tries, and it can only be
 * faked by adding a real column that every database then has to carry.
 */

/** A property every row has, whether or not the schema declares it. */
export const PSEUDO = {
  title: 'title',
  created: 'created',
  updated: 'updated',
} as const;

export type PseudoProperty = (typeof PSEUDO)[keyof typeof PSEUDO];

export function isPseudo(propertyId: string): propertyId is PseudoProperty {
  return propertyId === PSEUDO.title || propertyId === PSEUDO.created || propertyId === PSEUDO.updated;
}

// -------------------------------------------------------------------- filters

/**
 * The filter vocabulary.
 *
 * Named for what they do to a value, not for the property they apply to. Kept
 * small on purpose: every operator here has to be implemented, tested and
 * documented, and a long list of near-synonyms is a list of things that behave
 * subtly differently.
 */
export type FilterOp =
  | 'contains'
  | 'notContains'
  | 'is'
  | 'isNot'
  | 'empty'
  | 'notEmpty'
  | 'gt'
  | 'lt'
  | 'checked'
  | 'unchecked';

export const FILTER_LABELS: Record<FilterOp, string> = {
  contains: 'contains',
  notContains: 'does not contain',
  is: 'is',
  isNot: 'is not',
  empty: 'is empty',
  notEmpty: 'is not empty',
  gt: 'is after',
  lt: 'is before',
  checked: 'is checked',
  unchecked: 'is not checked',
};

/**
 * Which operators a property type can meaningfully use.
 *
 * Offering "is greater than" on a text column produces a filter that either
 * compares strings by code point -- which looks like it works and means nothing
 * to the person using it -- or refuses at the last moment. Restricting the list
 * per type is what keeps every offered filter honest.
 */
export function filterOpsFor(type: string): FilterOp[] {
  switch (type) {
    case 'number':
      return ['is', 'isNot', 'gt', 'lt', 'empty', 'notEmpty'];
    case 'date':
      return ['is', 'isNot', 'gt', 'lt', 'empty', 'notEmpty'];
    case 'checkbox':
      return ['checked', 'unchecked'];
    case 'select':
    case 'multiSelect':
      return ['is', 'isNot', 'empty', 'notEmpty'];
    case 'title':
      return ['contains', 'notContains', 'is', 'isNot', 'empty', 'notEmpty'];
    default:
      return ['contains', 'notContains', 'is', 'isNot', 'empty', 'notEmpty'];
  }
}

export interface FilterRule {
  propertyId: string;
  op: FilterOp;
  /** Compared against. Meaning depends on the property type. */
  value?: unknown;
}

export interface RowView {
  id: string;
  title: string;
  /** Page creation and edit times, epoch ms. */
  createdAt?: number;
  updatedAt?: number;
  values: Record<string, unknown>;
}

/**
 * Read a property's value from a row, resolving the pseudo-properties.
 *
 * Returns a comparable rather than the stored object, because comparing two
 * `{type:'number'}` wrappers directly is always false and the resulting filter
 * silently matches nothing -- which looks like there are no results rather than
 * like a bug.
 */
function comparable(row: RowView, propertyId: string): string | number | boolean | null {
  if (propertyId === PSEUDO.title) return row.title;
  if (propertyId === PSEUDO.created) return row.createdAt ?? null;
  if (propertyId === PSEUDO.updated) return row.updatedAt ?? null;

  const raw = row.values[propertyId];
  if (raw === null || raw === undefined) return null;
  const value = raw as { type?: string; [k: string]: unknown };

  switch (value.type) {
    case 'text':
      return typeof value.text === 'string' ? value.text : '';
    case 'number':
      return typeof value.number === 'number' ? value.number : null;
    case 'checkbox':
      return value.checked === true;
    case 'date':
      return typeof value.date === 'string' && value.date ? value.date : null;
    case 'select':
      return typeof value.optionId === 'string' ? value.optionId : null;
    case 'multiSelect':
      return Array.isArray(value.optionIds) ? value.optionIds.join(',') : '';
    case 'relation':
      return Array.isArray(value.pageIds) ? value.pageIds.join(',') : '';
    default:
      return null;
  }
}

/** True when the row's value for the rule's property satisfies the rule. */
export function matchesFilter(row: RowView, rule: FilterRule): boolean {
  const actual = comparable(row, rule.propertyId);

  const isEmpty =
    actual === null || actual === '' || (Array.isArray(actual) && actual.length === 0);
  if (rule.op === 'empty') return isEmpty;
  if (rule.op === 'notEmpty') return !isEmpty;
  if (isEmpty) return false; // every other operator on an empty value is false

  switch (rule.op) {
    case 'checked':
      return actual === true;
    case 'unchecked':
      return actual !== true;
    case 'contains':
      return String(actual).toLowerCase().includes(String(rule.value ?? '').toLowerCase());
    case 'notContains':
      return !String(actual).toLowerCase().includes(String(rule.value ?? '').toLowerCase());
    case 'is':
      return typeof actual === 'boolean' ? actual === Boolean(rule.value) : String(actual) === String(rule.value ?? '');
    case 'isNot':
      return typeof actual === 'boolean' ? actual !== Boolean(rule.value) : String(actual) !== String(rule.value ?? '');
    case 'gt':
      // Only numbers and dates reach this branch -- filterOpsFor offers gt and
      // lt for those two types and nothing else. Comparing a checkbox or a
      // string with > is meaningless, so it is refused rather than coerced.
      return typeof actual === 'number'
        ? actual > Number(rule.value)
        : typeof actual === 'string' && typeof rule.value === 'string'
          ? actual > rule.value
          : false;
    case 'lt':
      return typeof actual === 'number'
        ? actual < Number(rule.value)
        : typeof actual === 'string' && typeof rule.value === 'string'
          ? actual < rule.value
          : false;
    default:
      return false;
  }
}

/**
 * A filter tree.
 *
 * A rule is a leaf; a group combines its children with AND or OR. Groups nest,
 * so "status is done AND (owner is me OR owner is you)" is expressible.
 *
 * Modelled as a tagged union rather than a rule with optional children, because
 * the two are genuinely different things and the difference is where the bugs
 * live: a rule with no children has to mean "matches nothing" or "matches
 * everything" depending on how you read it, and both readings are wrong for
 * someone.
 */
export type FilterGroup =
  | { kind: 'rule'; rule: FilterRule }
  | { kind: 'group'; op: 'and' | 'or'; children: FilterGroup[] };

/**
 * What a view's filters may be.
 *
 * The flat rule list is kept because it is what every existing view stores and
 * what the CLI writes. A flat list of rules means AND, which is what it has
 * always meant.
 */
export type FilterSpec = FilterRule[] | FilterGroup[] | FilterGroup;

/** True when a value looks like a leaf rule rather than a group. */
function isRule(value: FilterRule | FilterGroup): value is FilterRule {
  return (value as FilterRule).propertyId !== undefined;
}

/**
 * Does a row match a group?
 *
 * An empty group matches everything. An empty *AND* group matching nothing
 * would mean a filter bar the user has emptied silently hides every row, which
 * reads as the data being gone.
 */
export function matchesGroup(row: RowView, group: FilterGroup): boolean {
  if (group.kind === 'rule') return matchesFilter(row, group.rule);
  if (group.children.length === 0) return true;
  if (group.op === 'or') return group.children.some((child) => matchesGroup(row, child));
  return group.children.every((child) => matchesGroup(row, child));
}

/** Rows matching every rule. An empty rule list matches everything. */
export function applyFilters(rows: RowView[], filters: FilterSpec | undefined | null): RowView[] {
  if (filters === undefined || filters === null) return rows;

  // A single group: use it as it stands.
  if (!Array.isArray(filters)) return rows.filter((row) => matchesGroup(row, filters));

  if (filters.length === 0) return rows;

  // A flat list of rules, which is what every existing view stores: AND.
  if (filters.every(isRule)) {
    const rules = filters as FilterRule[];
    return rows.filter((row) => rules.every((rule) => matchesFilter(row, rule)));
  }

  // A list of groups: AND of the groups, so a list of one group behaves the
  // same as the group itself.
  const groups = filters as FilterGroup[];
  return rows.filter((row) => groups.every((group) => matchesGroup(row, group)));
}

// ---------------------------------------------------------------------- sorts

export interface SortRule {
  propertyId: string;
  /** false = ascending, true = descending. */
  descending: boolean;
}

/**
 * Sort rows by one or more rules, first rule first.
 *
 * Ties fall back to the title. Without that, two rows with the same status
 * shuffle between renders in whatever order the database happened to return
 * them, which is the classic way to make a table feel broken.
 */
export function sortRows(rows: RowView[], sorts: SortRule[]): RowView[] {
  if (sorts.length === 0) return rows;
  const copy = [...rows];
  copy.sort((a, b) => {
    for (const rule of sorts) {
      const left = comparable(a, rule.propertyId);
      const right = comparable(b, rule.propertyId);
      if (left === right) continue;

      // Empties sort last regardless of direction. A column of blanks at the top
      // of a descending sort hides the data the user asked to see.
      if (left === null || left === '') return 1;
      if (right === null || right === '') return -1;

      let order: number;
      if (typeof left === 'number' && typeof right === 'number') {
        order = left - right;
      } else {
        order = String(left).localeCompare(String(right), undefined, { numeric: true });
      }
      return rule.descending ? -order : order;
    }
    return a.title.localeCompare(b.title);
  });
  return copy;
}

// ------------------------------------------------------------------- grouping

export interface RowGroup {
  /** Null for the group of rows that have no value at all. */
  key: string | null;
  label: string;
  color?: string;
  rows: RowView[];
}

/**
 * Group rows by one property.
 *
 * Every declared option gets a group even when empty. A board whose columns
 * appear only once something lands in them makes the shape of the data
 * undiscoverable, and an empty column is the only place a "nothing is here yet"
 * state can live.
 *
 * Rows with no value get a trailing group rather than being dropped. A row the
 * grouping silently removes is a row the user believes has vanished.
 */
export function groupRows(
  rows: RowView[],
  propertyId: string | null,
  options: { id: string; name: string; color: string }[] = [],
): RowGroup[] {
  if (!propertyId) {
    return [{ key: null, label: 'All', rows: [...rows] }];
  }

  const buckets = new Map<string | null, RowView[]>();
  for (const option of options) buckets.set(option.id, []);
  buckets.set(null, []);

  for (const row of rows) {
    const raw = comparable(row, propertyId);
    const key = raw === null || raw === '' ? null : String(raw);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else {
      // A value with no matching option -- renamed, or typed by hand. Collected
      // rather than discarded so it stays visible and fixable.
      const extra = buckets.get(null)!;
      extra.push(row);
    }
  }

  const groups: RowGroup[] = options.map((option) => ({
    key: option.id,
    label: option.name,
    color: option.color,
    rows: buckets.get(option.id) ?? [],
  }));

  const ungrouped = buckets.get(null) ?? [];
  if (ungrouped.length > 0) groups.push({ key: null, label: 'No value', rows: ungrouped });
  return groups;
}

// ----------------------------------------------------------------- the query

export interface ViewQuery {
  filters?: FilterSpec;
  sorts?: SortRule[];
}

export interface QueryResult {
  rows: RowView[];
  /** Every row before filtering, so the UI can say "3 of 12". */
  total: number;
}

/**
 * Apply a view's filter and sort.
 *
 * Filtering before sorting, and not the other way round. Sorting first is wasted
 * work, and worse it means the sort has to be stable across a filter that throws
 * rows away underneath it.
 */
export function runQuery(rows: RowView[], query: ViewQuery): QueryResult {
  const filtered = applyFilters(rows, query.filters ?? []);
  return { rows: sortRows(filtered, query.sorts ?? []), total: rows.length };
}
