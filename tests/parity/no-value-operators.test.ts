/**
 * Why the query bar only offers operators that need no value.
 *
 * These are the two behaviours that made the filter bar lie. A text column's
 * default operator is `contains`, and `contains` with an empty string matches
 * every row -- the filter appeared to do nothing. A number or select column
 * defaults to `is`, and comparing an option id against '' matches no row -- the
 * table went blank. The bar now ships only `empty`, `notEmpty`, `checked` and
 * `unchecked`; these tests are why, so nobody helpfully re-adds the others.
 */

import { describe, expect, it } from 'vitest';
import { matchesFilter, PSEUDO, type RowView } from '@ow/commands';

const rows: RowView[] = [
  { id: 'a', title: 'Alpha', values: { s: { type: 'select', optionId: 'opt-todo' } } },
  { id: 'b', title: 'Beta', values: { s: { type: 'select', optionId: 'opt-done' } } },
];

describe('operators with no value', () => {
  it('empty and notEmpty are meaningful with no value', () => {
    expect(matchesFilter(rows[0]!, { propertyId: 's', op: 'empty' })).toBe(false);
    expect(matchesFilter(rows[0]!, { propertyId: 's', op: 'notEmpty' })).toBe(true);
  });
});

describe('operators that need a value, and must not be offered without one', () => {
  it('contains with an empty value matches every row', () => {
    // The failure: the filter was set, the UI updated, and nothing was hidden.
    expect(matchesFilter(rows[0]!, { propertyId: PSEUDO.title, op: 'contains', value: '' })).toBe(true);
    expect(matchesFilter(rows[1]!, { propertyId: PSEUDO.title, op: 'contains', value: '' })).toBe(true);
  });

  it('is with an empty value matches no row', () => {
    // The other failure: the same filter blanked the table instead.
    expect(matchesFilter(rows[0]!, { propertyId: 's', op: 'is', value: '' })).toBe(false);
    expect(matchesFilter(rows[1]!, { propertyId: 's', op: 'is', value: '' })).toBe(false);
  });

  it('is works correctly once a real value is supplied', () => {
    // So the operators are not broken -- they are just unusable with no input,
    // which is why the bar hides them rather than the command rejecting them.
    expect(matchesFilter(rows[0]!, { propertyId: 's', op: 'is', value: 'opt-todo' })).toBe(true);
  });
});
