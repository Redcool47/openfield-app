/**
 * Fractional ordering.
 *
 * Sibling order is stored as a *fractional index*: a short string over base-62
 * digits that sorts lexicographically. Inserting between two siblings mints
 * exactly one new key; it never renumbers its neighbours. That is the entire
 * reason for using this rather than integers: moving one row in a fifty
 * thousand row database must not write fifty thousand rows.
 *
 * Why base-62 digits and plain string comparison is correct
 * --------------------------------------------------------
 * Treat a key as a fraction in [0, 1): the first digit is the integer part and
 * the remaining digits are the fractional expansion. Two keys then compare digit
 * by digit, with a key that runs out of digits treated as having trailing
 * zeros. Because the digit alphabet is in ASCII order, `a < b` in JavaScript
 * *is* numeric order on those fractions. Strings of unbounded length give an
 * unbounded key space with no maximum element, so there is always room to insert
 * after the current last key without an "infinity" sentinel.
 *
 * Why no key may end in the zero digit
 * ------------------------------------
 * That representation makes "z" and "z0" the *same* fraction (61/62) written
 * two ways. Lexicographically "z" sorts before "z0", so the pair looks like two
 * distinct ordered values while being numerically equal -- and nothing can be
 * inserted between them. A generator walking upward eventually produces "z0"
 * and strands itself permanently. This is not theoretical: the first version of
 * this file did exactly that and a 300-insertion stress test caught it.
 *
 * Forbidding a trailing zero removes the ambiguity completely. A key and any
 * extension of it by a nonzero digit are then genuinely different fractions, so
 * every legal key has room on both sides.
 *
 * Two schemes were rejected before this one and both are worth recording:
 *  - Integer keys with a fractional fallback. Reads nicely in a database dump,
 *    but variable-length integers are not lexicographically order-preserving
 *    ("az" < "b" while 10*62+61 > 11), so order silently breaks past 100 items.
 *  - Long fixed-width integers. Order-correct, but every insert rewrites every
 *    sibling, which is the entire problem fractional indexing exists to avoid.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const LAST = DIGITS.length - 1; // 61
const ZERO = DIGITS[0]!;
const ONE = DIGITS[1]!;

/**
 * The canonical first key. A middle digit rather than an all-zero key, so there
 * is always room to insert before it as well as after it.
 */
export const FIRST_KEY = 'V';

function val(ch: string): number {
  return DIGITS.indexOf(ch);
}

/** A key is legal when it is non-empty, uses only base-62 digits, and has no trailing zero. */
export function isLegalKey(key: string): boolean {
  if (key.length === 0) return false;
  if (key.length > 1 && key.endsWith(ZERO)) return false;
  for (const ch of key) if (val(ch) < 0) return false;
  return true;
}

/**
 * The smallest legal key strictly greater than `key`.
 * Returns FIRST_KEY for a null input, meaning "the first key of all".
 */
export function keyAfter(key: string | null): string {
  if (key === null) return FIRST_KEY;
  for (let i = key.length - 1; i >= 0; i -= 1) {
    const v = val(key[i]!);
    if (v < LAST) return key.slice(0, i) + DIGITS[v + 1]!;
  }
  // Every digit is maximal. A zero extension would be illegal (equal in value),
  // so continue the fraction with the smallest nonzero digit instead.
  return key + ONE;
}

/**
 * A legal key strictly less than `key` that itself still has room below it, or
 * null when `key` has no such predecessor (an all-zero key, which is not a legal
 * key anyway).
 *
 * The room matters: `keyBetween(null, k)` calls this on every prepend, and a
 * bare predecessor would strand the caller one insert later. So rather than
 * truncating the tail, the result always ends in the maximal digit: that makes
 * it legal (no trailing zero) and leaves the next lower digit available.
 *
 * Concretely this is why we cannot just truncate. For "01" the obvious
 * predecessor "0" is illegal -- it denotes the same fraction with no room below
 * it -- and "00" is illegal too, so the answer is "00z".
 */
export function keyBefore(key: string | null): string | null {
  if (key === null) return null;
  for (let i = key.length - 1; i >= 0; i -= 1) {
    const v = val(key[i]!);
    if (v === 0) continue;
    return key.slice(0, i) + DIGITS[v - 1]! + DIGITS[LAST];
  }
  return null;
}

/**
 * A legal key strictly between `lo` and `hi`. Either bound may be null, meaning
 * unbounded on that side.
 *
 * Invariants the caller relies on: the result is strictly greater than `lo`,
 * strictly less than `hi`, carries no trailing zero, and always leaves room for
 * a further insert on the same side.
 *
 * Throws rather than returning something out of range: a key that escapes its
 * bounds corrupts sibling order in a way that is extremely hard to notice
 * later, and a loud failure here is much cheaper to diagnose.
 */
export function keyBetween(lo: string | null, hi: string | null): string {
  if (lo !== null && hi !== null && lo >= hi) {
    throw new RangeError(`keyBetween requires lo < hi, got lo=${lo} hi=${hi}`);
  }
  if (lo === null) {
    if (hi === null) return FIRST_KEY;
    const below = keyBefore(hi);
    if (below === null) {
      throw new RangeError(`keyBetween has no room below the floor key ${hi}`);
    }
    return below;
  }
  if (hi === null) return keyAfter(lo);

  // Strip the shared prefix. If `lo` ends at the prefix it is shorter than
  // anything continuing that prefix, so the remaining lower bound is unbounded.
  let n = 0;
  while (n < hi.length && lo[n] === hi[n]) n += 1;
  if (n > 0) {
    return hi.slice(0, n) + keyBetween(lo.length > n ? lo.slice(n) : null, hi.slice(n));
  }

  // First digits genuinely differ.
  const a = val(lo[0]!);
  const b = val(hi[0]!);
  if (b - a > 1) return DIGITS[a + Math.floor((b - a) / 2)]!;

  // Adjacent digits, so there is no room between them at this depth.
  if (hi.length > 1) return hi[0]!; // "b..." beats "a" and loses to "b...rest"
  // `hi` is a bare digit, so descend on the lower side instead.
  return lo[0]! + keyBetween(lo.length > 1 ? lo.slice(1) : null, null);
}

/** The key a new sibling should take to land at `index` in an ordered list. */
export function keyAt(keys: readonly string[], index: number): string {
  if (index <= 0) return keyBetween(null, keys[0] ?? null);
  if (index >= keys.length) return keyAfter(keys[keys.length - 1] ?? null);
  return keyBetween(keys[index - 1]!, keys[index]!);
}

/**
 * Recompute keys for moving `from` to `to`, returning only the indices whose key
 * actually changed. Callers persist this map, so a move writes O(distance) rows
 * rather than O(length) rows.
 */
export function reindex(keys: readonly string[], from: number, to: number): Map<number, string> {
  const next = [...keys];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  const changes = new Map<number, string>();
  for (let i = 0; i < next.length; i += 1) {
    if (next[i] !== keys[i]) changes.set(i, next[i]!);
  }
  return changes;
}

export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortByKey<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareKeys(key(a), key(b)));
}