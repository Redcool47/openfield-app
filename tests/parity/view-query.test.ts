/**
 * Filtering, sorting and grouping.
 *
 * Written before the UI existed, deliberately. A filter that matches nothing is
 * indistinguishable from a database that has no rows, so every operator is
 * pinned here against data that should match and data that should not. The tests
 * that matter most here are the negative ones: an operator quietly returning
 * true for everything is the failure nobody notices until the filter is trusted
 * and relied on.
 */

import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  filterOpsFor,
  groupRows,
  matchesFilter,
  PSEUDO,
  runQuery,
  sortRows,
  type RowView,
} from '@ow/commands';

const rows: RowView[] = [
  {
    id: 'a',
    title: 'Ship installer',
    createdAt: 100,
    updatedAt: 500,
    values: {
      status: { type: 'select', optionId: 'done' },
      points: { type: 'number', number: 13 },
      due: { type: 'date', date: '2027-03-08' },
      flag: { type: 'checkbox', checked: true },
      tags: { type: 'multiSelect', optionIds: ['release'] },
    },
  },
  {
    id: 'b',
    title: 'Draft the spec',
    createdAt: 200,
    updatedAt: 300,
    values: {
      status: { type: 'select', optionId: 'progress' },
      points: { type: 'number', number: 3 },
      due: { type: 'date', date: '2027-03-14' },
      flag: { type: 'checkbox', checked: false },
      tags: { type: 'multiSelect', optionIds: ['writing', 'spec'] },
    },
  },
  {
    id: 'c',
    title: 'Fix sidebar',
    createdAt: 300,
    updatedAt: 400,
    values: {
      status: { type: 'select', optionId: 'blocked' },
      points: { type: 'number', number: null },
      due: { type: 'date', date: null },
      flag: { type: 'checkbox', checked: false },
    },
  },
  {
    id: 'd',
    title: 'Untitled row',
    createdAt: 400,
    updatedAt: 100,
    values: {},
  },
];

const ids = (list: RowView[]) => list.map((r) => r.id);

describe('filter operators', () => {
  it('restricts operators to what a type can meaningfully use', () => {
    // "is greater than" on a checkbox is either meaningless or a string
    // compare by code point, and either way it looks like it works.
    expect(filterOpsFor('checkbox')).toEqual(['checked', 'unchecked']);
    expect(filterOpsFor('number')).toContain('gt');
    expect(filterOpsFor('number')).not.toContain('contains');
    expect(filterOpsFor('select')).not.toContain('gt');
    expect(filterOpsFor('title')).toContain('contains');
  });

  it('matches a select by option id', () => {
    expect(matchesFilter(rows[0]!, { propertyId: 'status', op: 'is', value: 'done' })).toBe(true);
    expect(matchesFilter(rows[0]!, { propertyId: 'status', op: 'is', value: 'blocked' })).toBe(false);
    expect(matchesFilter(rows[0]!, { propertyId: 'status', op: 'isNot', value: 'blocked' })).toBe(true);
  });

  it('compares numbers numerically, not as strings', () => {
    // "9" > "13" is true as strings. If this ever regresses, filters silently
    // return the wrong rows rather than failing.
    const nine: RowView = { id: 'n', title: 'n', values: { p: { type: 'number', number: 9 } } };
    const thirteen: RowView = { id: 't', title: 't', values: { p: { type: 'number', number: 13 } } };
    expect(matchesFilter(nine, { propertyId: 'p', op: 'lt', value: 13 })).toBe(true);
    expect(matchesFilter(thirteen, { propertyId: 'p', op: 'lt', value: 13 })).toBe(false);
  });

  it('compares dates as strings, which is correct for ISO', () => {
    expect(matchesFilter(rows[0]!, { propertyId: 'due', op: 'lt', value: '2027-03-10' })).toBe(true);
    expect(matchesFilter(rows[1]!, { propertyId: 'due', op: 'gt', value: '2027-03-10' })).toBe(true);
  });

  it('treats an empty value as empty and fails every other operator on it', () => {
    const empty = rows[3]!;
    expect(matchesFilter(empty, { propertyId: 'status', op: 'empty' })).toBe(true);
    expect(matchesFilter(empty, { propertyId: 'status', op: 'notEmpty' })).toBe(false);
    // An unset value is not "equal to" anything, including the empty string.
    expect(matchesFilter(empty, { propertyId: 'status', op: 'is', value: '' })).toBe(false);
    expect(matchesFilter(empty, { propertyId: 'status', op: 'contains', value: 'x' })).toBe(false);
  });

  it('handles the checkbox operators', () => {
    expect(matchesFilter(rows[0]!, { propertyId: 'flag', op: 'checked' })).toBe(true);
    expect(matchesFilter(rows[1]!, { propertyId: 'flag', op: 'unchecked' })).toBe(true);
    expect(matchesFilter(rows[1]!, { propertyId: 'flag', op: 'checked' })).toBe(false);
  });

  it('does text contains case-insensitively', () => {
    expect(matchesFilter(rows[0]!, { propertyId: PSEUDO.title, op: 'contains', value: 'INSTALL' })).toBe(true);
  });

  it('searches multi-select values as a whole', () => {
    expect(matchesFilter(rows[1]!, { propertyId: 'tags', op: 'contains', value: 'writing' })).toBe(true);
    expect(matchesFilter(rows[0]!, { propertyId: 'tags', op: 'contains', value: 'writing' })).toBe(false);
  });
});

describe('pseudo-properties', () => {
  it('filters and sorts by title, created and updated without a schema column', () => {
    expect(matchesFilter(rows[2]!, { propertyId: PSEUDO.title, op: 'is', value: 'Fix sidebar' })).toBe(true);
    expect(matchesFilter(rows[2]!, { propertyId: PSEUDO.created, op: 'gt', value: 250 })).toBe(true);
    expect(matchesFilter(rows[2]!, { propertyId: PSEUDO.updated, op: 'lt', value: 250 })).toBe(false);
  });
});

describe('filters combined', () => {
  it('requires every rule to match', () => {
    const result = applyFilters(rows, [
      { propertyId: 'status', op: 'notEmpty' },
      { propertyId: 'points', op: 'gt', value: 5 },
    ]);
    expect(ids(result)).toEqual(['a']);
  });

  it('returns everything when there are no rules', () => {
    expect(applyFilters(rows, [])).toHaveLength(4);
  });
});

describe('sorting', () => {
  it('sorts ascending and descending, with empties last either way', () => {
    // points: a=13, b=3, c and d unset. Empties go last in both directions --
    // blanks at the top of a descending sort hide the data the user asked to
    // see -- and the two empties tie, broken by title.
    expect(ids(sortRows(rows, [{ propertyId: 'points', descending: false }]))).toEqual([
      'b', 'a', 'c', 'd',
    ]);
    expect(ids(sortRows(rows, [{ propertyId: 'points', descending: true }]))).toEqual([
      'a', 'b', 'c', 'd',
    ]);
  });

  it('sorts numbers numerically rather than as strings', () => {
    // "9" sorts after "13" as strings. This is the regression that makes a
    // number column look broken only for values under ten.
    const small: RowView[] = [
      { id: 'nine', title: 'nine', values: { p: { type: 'number', number: 9 } } },
      { id: 'thirteen', title: 'thirteen', values: { p: { type: 'number', number: 13 } } },
    ];
    expect(ids(sortRows(small, [{ propertyId: 'p', descending: false }]))).toEqual([
      'nine',
      'thirteen',
    ]);
  });

  it('falls back to the title so equal rows do not shuffle between renders', () => {
    const shuffled = [...rows].reverse();
    const a = ids(sortRows(shuffled, [{ propertyId: 'flag', descending: false }]));
    const b = ids(sortRows(rows, [{ propertyId: 'flag', descending: false }]));
    expect(a).toEqual(b);
  });

  it('applies rules in order, first rule first', () => {
    const result = sortRows(rows, [
      { propertyId: 'flag', descending: false },
      { propertyId: 'points', descending: true },
    ]);
    // Unchecked first; within them, highest points.
    expect(ids(result)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('does not mutate the input', () => {
    const before = ids(rows);
    sortRows(rows, [{ propertyId: 'points', descending: true }]);
    expect(ids(rows)).toEqual(before);
  });
});

describe('grouping', () => {
  const options = [
    { id: 'done', name: 'Done', color: '#4a9d6f' },
    { id: 'progress', name: 'In progress', color: '#2f6fed' },
    { id: 'blocked', name: 'Blocked', color: '#e06c5c' },
  ];

  it('gives every declared option a group, even an empty one', () => {
    // An empty column is the only place a "nothing here yet" state can live.
    const groups = groupRows(rows.slice(0, 3), 'status', options);
    expect(groups.map((g) => g.label)).toEqual(['Done', 'In progress', 'Blocked']);
    expect(groups.map((g) => g.rows.length)).toEqual([1, 1, 1]);
  });

  it('collects rows with no value rather than dropping them', () => {
    const groups = groupRows(rows, 'status', options);
    const ungrouped = groups.find((g) => g.key === null);
    expect(ungrouped).toBeDefined();
    expect(ids(ungrouped!.rows)).toEqual(['d']);
  });

  it('collects a value with no matching option instead of discarding it', () => {
    const orphan: RowView = { id: 'z', title: 'Orphan', values: { status: { type: 'select', optionId: 'gone' } } };
    const groups = groupRows([...rows, orphan], 'status', options);
    const ungrouped = groups.find((g) => g.key === null);
    expect(ids(ungrouped!.rows)).toEqual(['d', 'z']);
  });

  it('returns a single group when no property is given', () => {
    const groups = groupRows(rows, null, options);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(4);
  });
});

describe('runQuery', () => {
  it('reports how many rows existed before filtering', () => {
    // Without this the UI cannot say "3 of 12", which is the only way a user
    // learns that a filter is hiding something.
    const result = runQuery(rows, {
      filters: [{ propertyId: 'status', op: 'notEmpty' }],
    });
    expect(result.rows).toHaveLength(3);
    expect(result.total).toBe(4);
  });

  it('filters before sorting', () => {
    const result = runQuery(rows, {
      filters: [{ propertyId: 'flag', op: 'checked' }],
      sorts: [{ propertyId: 'points', descending: true }],
    });
    expect(ids(result.rows)).toEqual(['a']);
  });

  it('returns everything untouched with an empty query', () => {
    const result = runQuery(rows, {});
    expect(result.rows).toHaveLength(4);
    expect(result.total).toBe(4);
  });
});
