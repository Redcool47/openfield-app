#!/usr/bin/env node
/**
 * Generate the application icon.
 *
 * Original artwork, drawn here as pixel data rather than imported from an image
 * file. Three reasons for that choice:
 *
 *   - The project gains no dependency for one small file.
 *   - The artwork is reproducible. Running this script always produces
 *     byte-identical output, so the icon is diffable in review and cannot drift
 *     away from the source of truth.
 *   - Each size is rendered at its native resolution rather than resampled, so
 *     the stroke weight can be clamped per size. That last point matters more
 *     than it sounds: a 13-pixel stroke on a 256-pixel icon scales to 0.8
 *     pixels at 16, which renders as a grey smear. Clamping the minimum to
 *     roughly 1.5 device pixels is the difference between an icon that reads in
 *     the taskbar and one that does not.
 *
 * The sizes below are the ones Windows actually asks for. electron-builder and
 * NSIS both select from this set rather than downscaling the 256.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Sizes to embed in the .ico, ascending. Windows picks the nearest it needs. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * The palette, taken from the measured design tokens in design/tokens.json
 * rather than invented, so the icon belongs to the same system as the running
 * application.
 */
const INK = [0x2a, 0x2a, 0x28]; // measured page text colour, used as the plate
const PAPER = [0xfd, 0xfd, 0xfc]; // measured page background
const ACCENT = [0x2f, 0x6f, 0xed];

// --------------------------------------------------------------- rasteriser

/**
 * Source-over blend of one pixel. Alpha is accumulated rather than overwritten
 * so overlapping shapes compose in the order they are drawn, which is what lets
 * the three receding strokes below be painted back to front.
 */
function setPx(buf, size, x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
  const i = (y * size + x) * 4;
  const src = a / 255;
  const dstA = buf[i + 3] / 255;
  const outA = src + dstA * (1 - src);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c += 1) {
    buf[i + c] = Math.round((rgb[c] * src + buf[i + c] * dstA * (1 - src)) / outA);
  }
  buf[i + 3] = Math.round(outA * 255);
}

/**
 * Coverage of a pixel by a rounded rectangle, sampled on a 3x3 grid.
 *
 * Supersampling rather than a signed-distance test because rounded corners need
 * an antialiased edge and this is the smallest amount of code that gets one.
 */
function rrectCoverage(x, y, rx, ry, rw, rh, radius) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      const dx = Math.max(rx + radius - px, 0, px - (rx + rw - radius));
      const dy = Math.max(ry + radius - py, 0, py - (ry + rh - radius));
      if (dx * dx + dy * dy <= radius * radius) hits += 1;
    }
  }
  return hits / 9;
}

function paint(buf, size, rx, ry, rw, rh, radius, rgb, alpha = 1) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const c = rrectCoverage(x, y, rx, ry, rw, rh, radius);
      if (c > 0) setPx(buf, size, x, y, rgb, Math.round(255 * alpha * c));
    }
  }
}

/**
 * Stroke a rounded rectangle rather than filling it.
 *
 * Implemented as the difference of two coverages, painted once. Subtracting
 * coverage and compositing -- as opposed to painting an opaque fill and punching
 * a hole in it -- means overlapping strokes do not erase one another, so the
 * three rings can overlap freely and still read as outlines.
 */
function stroke(buf, size, rx, ry, rw, rh, radius, thickness, rgb, alpha = 1) {
  const innerRadius = Math.max(radius - thickness, 0.5);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const outer = rrectCoverage(x, y, rx, ry, rw, rh, radius);
      if (outer <= 0) continue;
      const inner = rrectCoverage(
        x,
        y,
        rx + thickness,
        ry + thickness,
        rw - thickness * 2,
        rh - thickness * 2,
        innerRadius,
      );
      const cov = outer - inner;
      if (cov > 0) setPx(buf, size, x, y, rgb, Math.round(255 * alpha * cov));
    }
  }
}

/**
 * Stroke one line segment with round caps, by distance to the segment.
 *
 * Added for the spiral below. The existing `stroke` draws rounded *rectangles*,
 * which cannot express a diagonal or a join; composing a polyline out of them
 * leaves notches at every corner, and at 16 pixels a one-pixel notch is most of
 * the stroke. Round caps make each segment end in a disc, so consecutive
 * segments join cleanly with no extra geometry.
 */
function segment(buf, size, x0, y0, x1, y1, thickness, rgb, alpha = 1) {
  const half = thickness / 2;
  const vx = x1 - x0;
  const vy = y1 - y0;
  const lenSq = vx * vx + vy * vy;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          const px = x + (sx + 0.5) / 3;
          const py = y + (sy + 0.5) / 3;
          // Projection onto the segment, clamped to its ends so the round caps
          // come out of the same calculation rather than being added separately.
          const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / lenSq));
          const dx = px - (x0 + t * vx);
          const dy = py - (y0 + t * vy);
          if (dx * dx + dy * dy <= half * half) hits += 1;
        }
      }
      if (hits > 0) setPx(buf, size, x, y, rgb, Math.round(255 * alpha * (hits / 9)));
    }
  }
}

/**
 * A soft elliptical shadow, painted source-over in one pass.
 *
 * Used for the cast shadow under the mark. A hard-edged shadow makes a flat
 * shape look pasted on, and the cube falloff here is what makes it read as
 * standing on a surface. Cubed rather than linear because a linear ramp ends at
 * a visible ellipse boundary.
 */
function softShadow(buf, size, cx, cy, rx, ry, rgb, maxAlpha) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5) / size - cx;
      const dy = (y + 0.5) / size - cy;
      const d = Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
      if (d >= 1) continue;
      const t = 1 - d;
      setPx(buf, size, x, y, rgb, Math.round(255 * maxAlpha * t * t * t));
    }
  }
}

/**
 * A wedge filled with a left-to-right alpha ramp.
 *
 * The mark's base is not a soft shadow and that was the first thing I got wrong.
 * A blurred ellipse reads as a smudge under the drawing; the reference shape is a
 * hard-edged wedge that is part of the mark, solid where it leaves the book and
 * fading to nothing at its far end. The ramp is horizontal because that is the
 * direction the wedge travels.
 *
 * Supersampled on a 3x3 grid for the same reason `rrectCoverage` is: the edges are
 * diagonal, and a binary test makes them jagged at every size.
 */
function wedge(buf, size, points, rgb, alphaFrom, alphaTo) {
  const xs = points.map((p) => p[0] * size);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const span = Math.max(x1 - x0, 1);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let hits = 0;
      for (let sy = 0; sy < 3; sy += 1) {
        for (let sx = 0; sx < 3; sx += 1) {
          // Crossing number: count edge crossings to the right of the sample.
          let inside = false;
          for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
            const xi = points[i][0] * size;
            const yi = points[i][1] * size;
            const xj = points[j][0] * size;
            const yj = points[j][1] * size;
            const py2 = py + (sy + 0.5) / 3;
            const px2 = px + (sx + 0.5) / 3;
            if (yi > py2 !== yj > py2 && px2 < ((xj - xi) * (py2 - yi)) / (yj - yi) + xi) {
              inside = !inside;
            }
          }
          if (inside) hits += 1;
        }
      }
      if (hits === 0) continue;
      const t = (px - x0) / span;
      const a = Math.max(0, Math.min(1, alphaFrom + (alphaTo - alphaFrom) * t));
      setPx(buf, size, x, y, rgb, Math.round(255 * a * (hits / 9)));
    }
  }
}
// ------------------------------------------------------------------- the mark

/**
 * An open book: two page panels meeting at a spine, standing on a light plate,
 * with a soft shadow cast to the lower right.
 *
 * Drawn here as pixel data rather than supplied as an image file, for the three
 * reasons in the header -- no dependency, byte-identical regeneration, and native
 * rendering per size. That last one is what lets the stroke clamp per size: a
 * stroke that reads at 256 becomes a grey smear at 16, and this mark has six
 * separate strokes converging at the spine, where that failure would be worst.
 *
 * Geometry is expressed as fractions of the edge length so one description
 * serves every size. The plate is deliberately near-square with a large radius,
 * which is the shape Windows and the web both expect and the only one that does
 * not look like a sticker on a dark taskbar.
 */
function draw(size) {
  const buf = new Uint8Array(size * size * 4);
  const u = (n) => n * size;

  // Black ground, full bleed.
  for (let i = 0; i < size * size; i += 1) {
    buf[i * 4] = 0;
    buf[i * 4 + 1] = 0;
    buf[i * 4 + 2] = 0;
    buf[i * 4 + 3] = 255;
  }

  // The plate.
  paint(buf, size, u(0.085), u(0.085), u(0.83), u(0.83), u(0.195), PAPER);

  // The wedge. Painted before the mark so the book sits on top of it, and solid
  // at the left where it leaves the book, fading to nothing at the right.
  wedge(
    buf,
    size,
    [
      [0.392, 0.700],
      [0.620, 0.780],
      [0.900, 0.880],
      [0.455, 0.862],
    ],
    [0, 0, 0],
    1,
    0,
  );

  // Stroke weight. Heavier than a line drawing would use: the reference is a
  // graphic mark, and at 16 pixels a hairline collapses to grey.
  const t = Math.max(u(0.058), 1.8);

  // Two panels, and they are deliberately not the same shape. The left one is
  // tall and leans; the right one is shorter and sits lower, as if the pages are
  // fanned out to the right. A symmetric pair reads as a window or a card, not
  // as a book seen from an angle.
  const left = [
    [0.235, 0.275],
    [0.472, 0.155],
    [0.472, 0.700],
    [0.235, 0.775],
  ];
  const right = [
    [0.528, 0.235],
    [0.775, 0.305],
    [0.775, 0.640],
    [0.528, 0.685],
  ];
  const outline = (points) => {
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      segment(buf, size, u(a[0]), u(a[1]), u(b[0]), u(b[1]), t, INK, 1);
    }
  };

  outline(left);
  outline(right);

  // The spine, drawn last so it wins where all three sets of strokes converge.
  segment(buf, size, u(0.5), u(0.175), u(0.5), u(0.695), t, INK, 1);

  return buf;
}

// -------------------------------------------------------------- PNG encoding

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(buf, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Each scanline is prefixed with a filter byte. Filter 0 keeps the encoder
  // trivial and the files are tiny anyway.
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    const at = y * (stride + 1);
    raw[at] = 0;
    Buffer.from(buf.buffer, y * stride, stride).copy(raw, at + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Pack several sizes into one ICO.
 *
 * Since Windows Vista an ICO entry may hold a PNG payload directly, so no BMP
 * encoding or resampling is needed. NSIS MUI insists on a real .ico and rejects
 * a .png with "invalid icon file", which is why this exists rather than pointing
 * the packaging config at the PNG.
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  // Entries are 16 bytes each and follow the header; image data comes after.
  const dir = Buffer.alloc(images.length * 16);
  let offset = 6 + dir.length;

  images.forEach((img, i) => {
    const at = i * 16;
    // 0 in a single byte means 256, which does not fit in the 8-bit field.
    const dim = img.size >= 256 ? 0 : img.size;
    dir[at] = dim;
    dir[at + 1] = dim;
    dir[at + 2] = 0; // palette size; 0 for truecolour
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(img.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

// ----------------------------------------------------------------------- main

const out = join(process.cwd(), 'apps', 'desktop', 'build');
mkdirSync(out, { recursive: true });

const images = SIZES.map((size) => ({ size, png: encodePng(draw(size), size) }));

writeFileSync(join(out, 'icon.png'), images[images.length - 1].png);
writeFileSync(join(out, 'icon.ico'), encodeIco(images));

// `--preview` writes each size as its own file so small-size legibility can be
// looked at directly. Reviewing a mark only at 256 is how unreadable marks ship:
// the detail that makes it interesting at full size is exactly the detail that
// vanishes at 16.
if (process.argv.includes('--preview')) {
  for (const img of images) {
    writeFileSync(join(out, `icon-${img.size}.png`), img.png);
  }
  console.log(`icon: --preview wrote ${SIZES.length} per-size PNGs to ${out}`);
}

console.log(
  `icon: wrote icon.png (256x256, ${images[images.length - 1].png.length} bytes) ` +
    `and icon.ico with ${SIZES.length} sizes [${SIZES.join(', ')}], each rendered natively`,
);
