/**
 * Nested filter groups.
 *
 * The rule being tested is that a group tree and the flat list that came before
 * it mean the same thing where they overlap. A filter bar that used to AND
 * three rules must keep ANDing three rules, or every existing view changes
 * what it shows -- which is the kind of change nobody notices until a user's
 * database has quietly lost rows.
 *
 * The other thing worth pinning down is the empty group. An empty AND group
 * matching nothing would mean clearing the filter bar hides every row, which
 * reads as the data being gone.
 */

import { describe, expect, it } from 'vitest';
import { applyFilters, matchesGroup, type FilterGroup, type FilterRule, type RowView } from '@ow/commands';

const row = (id: string, values: Record<string, unknown>): RowView => ({
  id,
  title: id,
  values,
});

/**
 * The rows carry typed values, because that is what the storage holds.
 *
 * A bare string in a value slot is read as a value with no `type`, and the
 * comparison then sees null and every rule is false -- so a test written with
 * plain strings passes nothing and fails every assertion, which is a confusing
 * way to learn the shape.
 */
const ROWS: RowView[] = [
  row('a', {
    status: { type: 'select', optionId: 'done' },
    owner: { type: 'text', text: 'me' },
    priority: { type: 'text', text: 'high' },
  }),
  row('b', {
    status: { type: 'select', optionId: 'todo' },
    owner: { type: 'text', text: 'me' },
    priority: { type: 'text', text: 'low' },
  }),
  row('c', {
    status: { type: 'select', optionId: 'done' },
    owner: { type: 'text', text: 'you' },
    priority: { type: 'text', text: 'low' },
  }),
  row('d', {
    status: { type: 'select', optionId: 'todo' },
    owner: { type: 'text', text: 'you' },
    priority: { type: 'text', text: 'high' },
  }),
];

const rule = (propertyId: string, op: string, value?: unknown) =>
  ({ propertyId, op, value }) as unknown as FilterRule;
const ids = (rows: RowView[]) => rows.map((r) => r.id).sort();

describe('nested filter groups', () => {
  it('a flat list of rules still ANDs them', () => {
    const out = applyFilters(ROWS, [rule('status', 'is', 'done'), rule('owner', 'is', 'me')]);
    expect(ids(out)).toEqual(['a']);
  });

  it('an empty rule list matches everything', () => {
    expect(applyFilters(ROWS, []).length).toBe(ROWS.length);
    expect(applyFilters(ROWS, undefined).length).toBe(ROWS.length);
  });

  it('an OR group matches either side', () => {
    const group: FilterGroup = {
      kind: 'group',
      op: 'or',
      children: [
        { kind: 'rule', rule: rule('status', 'is', 'done') },
        { kind: 'rule', rule: rule('owner', 'is', 'me') },
      ],
    };
    // a is done, b is mine, c is done. d is neither, so it is out.
    expect(ids(applyFilters(ROWS, group))).toEqual(['a', 'b', 'c']);
  });

  it('an AND group requires every child', () => {
    const group: FilterGroup = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'rule', rule: rule('status', 'is', 'done') },
        { kind: 'rule', rule: rule('owner', 'is', 'me') },
      ],
    };
    expect(ids(applyFilters(ROWS, group))).toEqual(['a']);
  });

  it('nests: a group inside a group', () => {
    // done AND (me OR you) AND high
    const group: FilterGroup = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'rule', rule: rule('status', 'is', 'done') },
        {
          kind: 'group',
          op: 'or',
          children: [
            { kind: 'rule', rule: rule('owner', 'is', 'me') },
            { kind: 'rule', rule: rule('owner', 'is', 'you') },
          ],
        },
        { kind: 'rule', rule: rule('priority', 'is', 'high') },
      ],
    };
    expect(ids(applyFilters(ROWS, group))).toEqual(['a']);
  });

  it('a list of groups is ANDed', () => {
    const groups: FilterGroup[] = [
      { kind: 'rule', rule: rule('status', 'is', 'done') },
      { kind: 'rule', rule: rule('owner', 'is', 'you') },
    ];
    expect(ids(applyFilters(ROWS, groups))).toEqual(['c']);
  });

  it('a list of one group behaves like the group itself', () => {
    const group: FilterGroup = {
      kind: 'group',
      op: 'or',
      children: [
        { kind: 'rule', rule: rule('status', 'is', 'done') },
        { kind: 'rule', rule: rule('owner', 'is', 'me') },
      ],
    };
    expect(ids(applyFilters(ROWS, [group]))).toEqual(ids(applyFilters(ROWS, group)));
  });

  it('an empty group matches everything rather than hiding every row', () => {
    // Clearing the filter bar and having the table go empty reads as the data
    // being lost.
    const empty: FilterGroup = { kind: 'group', op: 'and', children: [] };
    expect(applyFilters(ROWS, empty).length).toBe(ROWS.length);
    expect(applyFilters(ROWS, { kind: 'group', op: 'or', children: [] }).length).toBe(ROWS.length);
  });

  it('matchesGroup is the same decision the filter makes', () => {
    const group: FilterGroup = {
      kind: 'group',
      op: 'or',
      children: [{ kind: 'rule', rule: rule('status', 'is', 'done') }],
    };
    expect(matchesGroup(ROWS[0]!, group)).toBe(true);
    expect(matchesGroup(ROWS[1]!, group)).toBe(false);
  });

  it('a group with a rule and a group mixes both kinds of child', () => {
    const group: FilterGroup = {
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'rule', rule: rule('owner', 'is', 'me') },
        {
          kind: 'group',
          op: 'or',
          children: [
            { kind: 'rule', rule: rule('status', 'is', 'done') },
            { kind: 'rule', rule: rule('priority', 'is', 'high') },
          ],
        },
      ],
    };
    // Only a: b is mine but neither done nor high, and d is high but not mine.
    expect(ids(applyFilters(ROWS, group))).toEqual(['a']);
  });
});
