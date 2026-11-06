/** Small pure helpers shared by every layer. No I/O, no platform access. */

/** Deterministic structural equality for JSON-shaped values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    Object.prototype.hasOwnProperty.call(b, k) &&
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** Structural clone via JSON, with a typed result. Values in this project are JSON-shaped. */
export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Compact `unknown` -> `Error` conversion that preserves thrown strings. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Concatenate class names, skipping falsy entries. Keeps markup tidy without
 * pulling in a dependency for a two-line function.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Assert a condition, typed as an assertion for callers. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invariant: ${message}`);
}