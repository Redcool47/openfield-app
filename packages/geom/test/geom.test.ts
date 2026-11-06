import { describe, expect, it } from 'vitest';
import { newId, isId, idTime, MAX_ID } from '@ow/geom';
import { keyBetween, keyAfter, keyBefore, keyAt, reindex, sortByKey, isLegalKey } from '@ow/geom';

describe('ids', () => {
  it('produces well-formed UUIDv7 values', () => {
    const id = newId(1_700_000_000_000);
    expect(isId(id)).toBe(true);
    expect(idTime(id)).toBe(1_700_000_000_000);
  });

  it('is strictly increasing for ids minted in the same millisecond', () => {
    const ids: string[] = [];
    for (let i = 0; i < 5000; i += 1) ids.push(newId(1_700_000_000_000));
    const sorted = [...ids].sort();
    expect(new Set(ids).size).toBe(5000);
    expect(sorted).toEqual(ids);
  });

  it('stays monotonically increasing when the clock jumps backwards', () => {
    const a = newId(2_000_000_000_000);
    const b = newId(1_000_000_000_000);
    expect(b > a).toBe(true);
    expect(idTime(b)).toBeGreaterThanOrEqual(2_000_000_000_000);
  });

  it('rejects malformed ids', () => {
    expect(isId('nope')).toBe(false);
    expect(isId('00000000-0000-0000-0000-000000000000')).toBe(false); // version 0, not 7
    expect(isId(42)).toBe(false);
  });
});

describe('fractional ordering', () => {
  it('never produces an illegal key while appending', () => {
    let last: string | null = null;
    for (let i = 0; i < 5000; i += 1) {
      last = keyAfter(last);
      expect(isLegalKey(last)).toBe(true);
    }
  });

  it('never produces an illegal key while prepending', () => {
    let first: string | null = keyAfter(null);
    for (let i = 0; i < 500; i += 1) {
      const next = keyBetween(null, first);
      expect(isLegalKey(next)).toBe(true);
      expect(next < first!).toBe(true);
      first = next;
    }
  });

  it('appends without touching earlier keys', () => {
    let last: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      last = keyAfter(last);
      keys.push(last);
    }
    expect(keys).toEqual(sortByKey(keys, (k) => k));
    expect(new Set(keys).size).toBe(200);
  });

  it('inserts between neighbours by minting exactly one key', () => {
    const a = keyAfter(null);
    const b = keyAfter(a);
    const mid = keyBetween(a, b);
    expect(a < mid).toBe(true);
    expect(mid < b).toBe(true);
    expect(isLegalKey(mid)).toBe(true);
  });

  it('survives repeated insertion at the same point', () => {
    let lo = keyAfter(null);
    let hi = keyAfter(lo);
    for (let i = 0; i < 60; i += 1) {
      const mid = keyBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      expect(isLegalKey(mid)).toBe(true);
      lo = mid;
    }
  });

  it('rejects an out-of-order range instead of corrupting order', () => {
    expect(() => keyBetween('m', 'a')).toThrow(RangeError);
  });

  it('places a key at an index among siblings', () => {
    const keys = [keyAfter(null), keyAfter(keyAfter(null)), keyAfter(keyAfter(keyAfter(null)))];
    const at0 = keyAt(keys, 0);
    expect(at0 < keys[0]!).toBe(true);
    const at3 = keyAt(keys, 3);
    expect(at3 > keys[2]!).toBe(true);
  });

  it('reindexes a move so only the affected range changes', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const changes = reindex(keys, 4, 1);
    const after = [...keys];
    for (const [i, k] of changes) after[i] = k;
    expect(after).toEqual(['a', 'e', 'b', 'c', 'd']);
    // 'a' did not move, so it keeps its key: a move writes four rows, not five.
    expect(changes.size).toBe(4);
  });

  it('keeps order correct past the point a naive scheme breaks', () => {
    // Regression guard: a scheme mixing short integer keys with fractional keys
    // is not lexicographically order-preserving ("az" < "b" while 10*62+61 > 11).
    const keys: string[] = [];
    let last: string | null = null;
    for (let i = 0; i < 5000; i += 1) {
      last = keyAfter(last);
      keys.push(last);
    }
    for (let i = 1; i < keys.length; i += 1) {
      expect(keys[i]! > keys[i - 1]!).toBe(true);
    }
  });

  it('keeps order correct under heavy mid-list insertion', () => {
    // The case that found the "z"/"z0" equal-fraction bug: a naive key generator
    // eventually emits a key with no room between it and its own prefix.
    const keys: string[] = [];
    let lo: string | null = null;
    for (let i = 0; i < 400; i += 1) {
      const k = keyBetween(lo, null);
      keys.push(k);
      lo = k;
    }
    for (let i = 0; i < 300; i += 1) {
      const at = 1 + Math.floor(((keys.length - 1) * (i + 1)) / 301);
      const k = keyBetween(keys[at - 1]!, keys[at] ?? null);
      expect(isLegalKey(k)).toBe(true);
      keys.splice(at, 0, k);
    }
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('offers room below the current first key', () => {
    const first = keyAfter(null);
    expect(keyBefore(first)).not.toBeNull();
    expect(keyBefore(first)! < first).toBe(true);
  });

  it('agrees with an exact numeric reference over many generated keys', () => {
    // Independent check: convert keys to exact scaled BigInts and confirm the
    // string ordering agrees. BigInt rather than Number because keys differing
    // only in deep digits are equal as doubles, which would hide real bugs.
    const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const SCALE = 12;
    const toScaled = (k: string) => {
      let n = 0n;
      for (let i = 0; i < SCALE; i += 1) {
        const v = i < k.length ? BigInt(ALPHABET.indexOf(k[i]!)) : 0n;
        n = n * 62n + v;
      }
      return n;
    };
    const keys: string[] = [];
    let lo: string | null = null;
    for (let i = 0; i < 300; i += 1) {
      lo = keyBetween(lo, null);
      const a = lo;
      const b = keyBetween(a, null);
      keys.push(a, b);
      lo = b;
    }
    for (let i = 1; i < keys.length; i += 1) {
      expect(keys[i]! > keys[i - 1]!).toBe(true);
      expect(toScaled(keys[i]!)).toBeGreaterThan(toScaled(keys[i - 1]!));
    }
  });
});