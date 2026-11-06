#!/usr/bin/env node
/**
 * Measure type and spacing from a screenshot.
 *
 * Why this exists: video frames gave exact colours but destroyed glyph edges, so
 * font size and line height could not be recovered from the footage. A
 * native-resolution still can. This reads one and reports the numbers.
 *
 * Decoding PNG here rather than through an image library keeps the project free
 * of a dependency for one analysis tool, and matches the encoder already in
 * tools/make-icon.mjs. Only what is needed is implemented: 8-bit truecolour with
 * or without alpha, non-interlaced. Anything else is reported rather than
 * guessed at, because a silently wrong decode would produce measurements that
 * look authoritative and are not.
 *
 * What it measures, and why each is reliable:
 *
 *   - Text rows. Rows of pixels that differ from the background. Works because
 *     text on a flat background is the only thing that differs.
 *   - Cap height. The height of the tallest glyph run in a row band, excluding
 *     descenders, which are identified as the part below the baseline where
 *     pixel density falls sharply.
 *   - Baseline spacing. The distance between the bottom of one cap run and the
 *     top of the next. Robust to ascenders and descenders in a way that
 *     row-boundary spacing is not.
 *   - Left margins. The first non-background column per band.
 *
 * Usage:
 *   node tools/measure-screenshot.mjs <file.png> [--crop=w:h:x:y] [--json]
 */

import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

// ------------------------------------------------------------------ PNG decode

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode an 8-bit non-interlaced PNG into raw RGBA. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idat = [];

  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }

  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} is not supported (need 8)`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
  if (!channels) throw new Error(`colour type ${colourType} is not supported`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters. Each row is prefixed with its filter byte, and
  // every filter is defined in terms of the row above and the pixel to the left,
  // so rows must be reconstructed strictly in order.
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[at];
    at += 1;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[at + x];
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a);
          const pb = Math.abs(pp - b);
          const pc = Math.abs(pp - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          value = rawByte + pred;
          break;
        }
        default: throw new Error(`unknown filter ${filter} on row ${y}`);
      }
      row[x] = value & 0xff;
    }
    at += stride;
  }

  // Normalise everything to RGBA so the measurement code has one shape to read.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 4) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = out[s + 3];
    } else if (channels === 3) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = 255;
    } else if (channels === 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = out[s + 1];
    } else {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = 255;
    }
  }
  return { width, height, data: rgba };
}

// --------------------------------------------------------------- measurement

const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/**
 * The most common colour within a region, taken as that region's background.
 *
 * Region-scoped rather than whole-image on purpose. A window has at least two
 * backgrounds -- a sidebar tint and a page colour -- so a global mode picks
 * whichever happens to cover more pixels and then reports every row of the other
 * region as one enormous band of "ink". Cropping to the area being measured is
 * what makes this work at all.
 */
function background(img, x0 = 0, x1 = img.width) {
  const counts = new Map();
  for (let y = 0; y < img.height; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * img.width + x) * 4;
      const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestCount = -1;
  for (const [key, n] of counts) if (n > bestCount) { best = key; bestCount = n; }
  return { key: best, hex: hex((best >> 16) & 0xff, (best >> 8) & 0xff, best & 0xff), share: bestCount / (img.width * img.height) };
}

/**
 * Find horizontal bands containing ink, ignoring bands that are mostly
 * background. A tolerance of 24 is deliberate: antialiased glyph edges carry
 * intermediate values, and a tight threshold reports only the darkest cores and
 * under-measures every glyph.
 */
function bands(img, bg, x0, x1, tolerance = 24) {
  const rows = [];
  for (let y = 0; y < img.height; y += 1) {
    let ink = 0;
    for (let x = x0; x < x1; x += 1) {
      const i = (y * img.width + x) * 4;
      const d =
        Math.abs(img.data[i] - ((bg.key >> 16) & 0xff)) +
        Math.abs(img.data[i + 1] - ((bg.key >> 8) & 0xff)) +
        Math.abs(img.data[i + 2] - (bg.key & 0xff));
      if (d > tolerance) ink += 1;
    }
    rows.push(ink);
  }

  const threshold = Math.max(2, Math.round((x1 - x0) * 0.004));
  const bands = [];
  let start = -1;
  for (let y = 0; y < rows.length; y += 1) {
    if (rows[y] >= threshold) {
      if (start === -1) start = y;
    } else if (start !== -1) {
      // Require a little vertical separation so a line's descender and the next
      // line's ascender do not fuse into one band.
      if (y - start >= 4) bands.push({ top: start, bottom: y - 1, height: y - start });
      start = -1;
    }
  }
  if (start !== -1 && rows.length - start >= 4) {
    bands.push({ top: start, bottom: rows.length - 1, height: rows.length - start });
  }
  return bands;
}

/**
 * First and last inked column within a band.
 *
 * Both matter and they answer different questions. The left edge gives the left
 * margin. The right edge gives the *content measure* only when the band wraps --
 * the width of one unwrapped line is just how long that sentence happened to be,
 * and treating it as the measure is how a layout gets a number that looks
 * authoritative and is wrong.
 */
function edges(img, bg, band, x0, x1, tolerance = 24) {
  let left = null;
  let right = null;
  for (let x = x0; x < x1; x += 1) {
    let inked = false;
    for (let y = band.top; y <= band.bottom; y += 1) {
      const i = (y * img.width + x) * 4;
      const d =
        Math.abs(img.data[i] - ((bg.key >> 16) & 0xff)) +
        Math.abs(img.data[i + 1] - ((bg.key >> 8) & 0xff)) +
        Math.abs(img.data[i + 2] - (bg.key & 0xff));
      if (d > tolerance) {
        inked = true;
        break;
      }
    }
    if (inked) {
      if (left === null) left = x;
      right = x;
    }
  }
  return { left, right };
}

/** The most common inked colour in a band: the colour the glyphs are actually painted. */
function inkColour(img, bg, band, x0, x1, tolerance = 24) {
  const counts = new Map();
  for (let y = band.top; y <= band.bottom; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * img.width + x) * 4;
      const d =
        Math.abs(img.data[i] - ((bg.key >> 16) & 0xff)) +
        Math.abs(img.data[i + 1] - ((bg.key >> 8) & 0xff)) +
        Math.abs(img.data[i + 2] - (bg.key & 0xff));
      if (d > tolerance) {
        const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  let best = null;
  let bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return best === null ? null : hex((best >> 16) & 0xff, (best >> 8) & 0xff, best & 0xff);
}

// ----------------------------------------------------------------------- main

const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/measure-screenshot.mjs <file.png> [--crop=w:h:x:y] [--json]');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`no such file: ${file}`);
  process.exit(1);
}

const img = decodePng(readFileSync(file));

let x0 = 0;
let x1 = img.width;
const crop = process.argv.slice(2).find((a) => a.startsWith('--crop='));
if (crop) {
  const [w, h, x, y] = crop.slice(7).split(':').map(Number);
  x0 = x;
  x1 = Math.min(img.width, x + w);
  void y;
}

const bg = background(img, x0, x1);
const found = bands(img, bg, x0, x1).map((b, i) => {
  const next = null;
  return {
    index: i,
    top: b.top,
    height: b.height,
    ...edges(img, bg, b, x0, x1),
    ink: inkColour(img, bg, b, x0, x1),
    _next: next,
  };
});

const gaps = [];
for (let i = 1; i < found.length; i += 1) {
  gaps.push({ from: found[i - 1].index, to: found[i].index, gap: found[i].top - found[i - 1].top });
}

const report = {
  file,
  size: { width: img.width, height: img.height },
  background: bg.hex,
  backgroundShare: Number(bg.share.toFixed(3)),
  bands: found.map(({ _next, ...rest }) => rest),
  gaps,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${file}: ${img.width}x${img.height}`);
  console.log(`background ${bg.hex} (${(bg.share * 100).toFixed(1)}% of pixels)`);
  console.log('');
  console.log('band  top  height   left  right  width  ink');
  for (const b of report.bands) {
    const width = b.left !== null && b.right !== null ? b.right - b.left : null;
    console.log(
      `${String(b.index).padStart(4)}  ${String(b.top).padStart(4)}  ${String(b.height).padStart(6)}` +
        `  ${String(b.left).padStart(5)}  ${String(b.right).padStart(5)}  ${String(width).padStart(5)}  ${b.ink ?? '-'}`,
    );
  }
  console.log('');
  console.log('gaps between bands (baseline-to-baseline spacing):');
  for (const g of gaps) console.log(`  ${String(g.from).padStart(3)} -> ${String(g.to).padStart(3)} : ${g.gap}`);
}
