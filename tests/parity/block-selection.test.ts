/**
 * Multi-block selection ranges.
 *
 * The negative tests carry the weight here. A selection bug does not look like a
 * crash -- it looks like a highlight in roughly the right place -- so the only way
 * to pin it down is to assert on the ranges that must *not* happen, particularly
 * the one where a stale id selects the whole page.
 */

import { describe, expect, it } from 'vitest';
import {
  blockRange,
  blockRangeSet,
  collapseSelection,
  nextSelection,
} from '../../apps/desktop/src/renderer/block-selection.js';

// Deliberately unsorted ids, so any implementation that sorts by id fails. Ids
// encode creation time in this schema, so document order and id order are not
// the same thing and assuming they are is the classic version of this bug.
const order = ['c', 'a', 'f', 'b', 'e'];

describe('blockRange', () => {
  it('returns a single block when anchor and focus match', () => {
    expect(blockRange(order, 'a', 'a')).toEqual(['a']);
  });

  it('works in either direction', () => {
    // Dragging upwards must select the same blocks as dragging downwards. A
    // selection that only grows one way surprises someone mid-rearrangement.
    expect(blockRange(order, 'a', 'e')).toEqual(['a', 'f', 'b', 'e']);
    expect(blockRange(order, 'e', 'a')).toEqual(['a', 'f', 'b', 'e']);
  });

  it('follows document order, not id order', () => {
    expect(blockRange(order, 'f', 'b')).toEqual(['f', 'b']);
    expect(blockRange(order, 'b', 'f')).toEqual(['f', 'b']);
  });

  it('is inclusive of both ends', () => {
    // Off-by-one here deletes one block fewer than the user highlighted, which
    // is the bug that looks like the app "eating" text.
    expect(blockRange(order, 'c', 'b')).toEqual(['c', 'a', 'f', 'b']);
  });

  it('selects nothing when an id is stale', () => {
    // The failure this guards: a row deleted a moment ago leaves a stale id, and
    // defaulting to index 0 would select from the top of the page. The next
    // keystroke is a delete.
    expect(blockRange(order, 'gone', 'b')).toEqual([]);
    expect(blockRange(order, 'b', 'gone')).toEqual([]);
    expect(blockRange(order, 'gone', 'gone')).toEqual([]);
  });

  it('handles an empty document', () => {
    expect(blockRange([], 'a', 'b')).toEqual([]);
  });
});

describe('blockRangeSet', () => {
  it('gives the same membership as the array form', () => {
    const set = blockRangeSet(order, 'a', 'b');
    expect([...set].sort()).toEqual(['a', 'f', 'b'].sort());
  });

  it('is empty with no anchor, rather than selecting everything', () => {
    expect(blockRangeSet(order, null, 'b').size).toBe(0);
    expect(blockRangeSet(order, 'a', null).size).toBe(0);
    expect(blockRangeSet(order, null, null).size).toBe(0);
  });
});

describe('nextSelection', () => {
  it('starts fresh when not extending', () => {
    expect(nextSelection({ anchor: 'a', focus: 'e' }, 'c', false)).toEqual({
      anchor: 'c',
      focus: 'c',
    });
  });

  it('keeps the anchor when extending', () => {
    // The point of extend: the anchor must not move, or the range grows from the
    // wrong end and the user's first click is forgotten.
    expect(nextSelection({ anchor: 'a', focus: 'f' }, 'b', true)).toEqual({
      anchor: 'a',
      focus: 'b',
    });
  });

  it('treats extending with no existing anchor as a fresh selection', () => {
    expect(nextSelection({ anchor: null, focus: null }, 'c', true)).toEqual({
      anchor: 'c',
      focus: 'c',
    });
  });
});

describe('collapseSelection', () => {
  it('resets to a single block, dropping the old range', () => {
    expect(collapseSelection({ anchor: 'a', focus: 'e' }, 'b')).toEqual({
      anchor: 'b',
      focus: 'b',
    });
  });
});