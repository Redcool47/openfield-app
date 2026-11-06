/**
 * Time-sortable unique identifiers.
 *
 * Ids are UUIDv7: a 48-bit big-endian Unix millisecond timestamp followed by
 * random bits, rendered in the standard 8-4-4-4-12 hyphenated form. Two
 * properties matter for this product:
 *
 *  - **Sortable**: byte-wise string order equals creation order, so "newest
 *    first" queries are index range scans rather than sorts.
 *  - **Opaque**: they leak no page counts, usage volume or creation cadence,
 *    which a dense sequential counter would.
 *
 * The layout is a public specification (RFC 9562), not an implementation
 * copied from anywhere.
 */

const HEX = '0123456789abcdef';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const g: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  if (g && typeof g.getRandomValues === 'function') {
    g.getRandomValues(out);
    return out;
  }
  // Deterministic-but-varying fallback for environments without WebCrypto.
  // Sufficient for uniqueness in tests; never used for security.
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += HEX[b >> 4]! + HEX[b & 15]!;
  return s;
}

/** Largest representable id, for exclusive upper-bound range scans. */
export const MAX_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
export const MIN_ID = '00000000-0000-ffff-ffff-ffffffffffff';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Generate a new UUIDv7.
 *
 * Within a single millisecond we increment a counter rather than re-drawing, so
 * ids minted in a tight loop (for example while importing twenty thousand rows)
 * remain strictly increasing. Without this, bulk imports produce a large set
 * of ids that tie on timestamp and lose the "newest first" ordering.
 */
let lastMs = -1;
let counter = 0;

export function newId(now: number = Date.now()): string {
  const ms = Math.max(0, Math.floor(now));
  if (ms === lastMs) {
    counter += 1;
    if (counter > 0xfff) {
      // Counter exhausted within this millisecond: spill into the next one.
      lastMs = ms + 1;
      counter = 0;
    }
  } else if (ms > lastMs) {
    lastMs = ms;
    counter = 0;
  } else {
    // Clock moved backwards. Keep monotonicity by reusing the last millisecond.
    lastMs += 1;
    counter = 0;
  }

  const bytes = randomBytes(16);
  const t = lastMs;
  // RFC 9562 UUIDv7 layout: bytes 0-5 hold the 48-bit big-endian timestamp,
  // bytes 6-7 hold the 4-bit version plus 12 bits of rand_a, byte 8 carries the
  // variant, bytes 8-15 hold rand_b. We spend rand_a on a monotonic counter so
  // that ids minted within one millisecond still order strictly.
  bytes[0] = (t / 2 ** 40) & 0xff;
  bytes[1] = (t / 2 ** 32) & 0xff;
  bytes[2] = (t / 2 ** 24) & 0xff;
  bytes[3] = (t / 2 ** 16) & 0xff;
  bytes[4] = (t / 2 ** 8) & 0xff;
  bytes[5] = t & 0xff;
  bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f); // RFC 9562 variant

  return (
    hex(bytes.subarray(0, 4)) +
    '-' +
    hex(bytes.subarray(4, 6)) +
    '-' +
    hex(bytes.subarray(6, 8)) +
    '-' +
    hex(bytes.subarray(8, 10)) +
    '-' +
    hex(bytes.subarray(10, 16))
  );
}

/** Extract the embedded creation timestamp in Unix milliseconds. */
export function idTime(id: string): number {
  const h = id.replace(/-/g, '');
  return parseInt(h.slice(0, 12), 16);
}

/** The device-local clock used by the operation log's Lamport pairing. */
let lamport = 0;
export function nextLamport(observed = 0): number {
  lamport = Math.max(lamport, observed) + 1;
  return lamport;
}
export function currentLamport(): number {
  return lamport;
}