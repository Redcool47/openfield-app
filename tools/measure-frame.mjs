#!/usr/bin/env node
/**
 * Measure a reference frame and emit a design-token palette.
 *
 * Why this exists
 * ---------------
 * The fidelity contract says "looks the same is a number, not an opinion". A
 * palette inferred by eye is an opinion, and every downstream colour inherits
 * that error. This reads actual pixels out of a reference frame and reports the
 * most common colours plus the geometry of the regions they occupy.
 *
 * Method
 * ------
 * ffmpeg decodes one frame to raw RGB on stdout; this script counts colours,
 * discards near-invisible ones, and reports the survivors ranked by how much of
 * the frame each covers. Quantisation is to a 4-bit-per-channel grid so that
 * anti-aliasing does not split one colour into a dozen near-identical entries,
 * and the reported value is the mean of every pixel that fell in each bucket.
 *
 * Usage: node tools/measure-frame.mjs <video|frame> <timestampSeconds> [--json]
 */

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const input = args.find((a) => !a.startsWith('--') && !/^-?\d+(\.\d+)?$/.test(a));
const seconds = args.find((a) => /^-?\d+(\.\d+)?$/.test(a));
const cropArg = args.find((a) => a.startsWith('--crop='));
const crop = cropArg ? cropArg.slice('--crop='.length) : null;

if (!input) {
  console.error('usage: measure-frame.mjs <input> <seconds> [--json]');
  process.exit(2);
}

/** Decode one frame to raw RGB via ffmpeg. */
function readFrame(file, at, crop) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', file,
       ...(crop ? ['-vf', `crop=${crop}`] : []),
       '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    let err = '';
    ff.stderr.on('data', (c) => (err += c));
    ff.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err || `ffmpeg exit ${code}`)),
    );
    ff.on('error', reject);
  });
}

/** Ask ffmpeg for the frame dimensions without decoding pixels. */
function dimensions(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
       '-of', 'csv=p=0:s=x', file],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    ff.stdout.on('data', (c) => (out += c));
    ff.on('close', () => {
      const [w, h] = out.trim().split('x').map(Number);
      if (w && h) resolve({ width: w, height: h });
      else reject(new Error(`could not read dimensions: ${out}`));
    });
    ff.on('error', reject);
  });
}

const hex = (r, g, b) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/** Perceived luminance, for deciding which colours are text on which. */
function luma(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const STEP = 4; // 4 bits per channel

async function main() {
  const { width, height } = await dimensions(input);
  const buf = await readFrame(input, seconds ?? '0', crop);
  // When cropping, the decoded buffer is the crop size, not the frame size.
  const [cw, ch] = crop ? crop.split(':').map(Number) : [width, height];
  const expected = cw * ch * 3;
  if (buf.length < expected) {
    throw new Error(`short frame: got ${buf.length} bytes, expected ${expected}`);
  }

  // Quantise into buckets, tracking count and summed channel values so the
  // reported colour is the bucket mean rather than an arbitrary member.
  const buckets = new Map();
  for (let i = 0; i < expected; i += 3) {
    const r = buf[i];
    const g = buf[i + 1];
    const b = buf[i + 2];
    const key = ((r >> STEP) << 8) | ((g >> STEP) << 4) | (b >> STEP);
    let e = buckets.get(key);
    if (!e) {
      e = { n: 0, r: 0, g: 0, b: 0 };
      buckets.set(key, e);
    }
    e.n += 1;
    e.r += r;
    e.g += g;
    e.b += b;
  }

  const total = cw * ch;
  const colours = [...buckets.values()]
    .map((e) => ({
      hex: hex(Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)),
      r: Math.round(e.r / e.n),
      g: Math.round(e.g / e.n),
      b: Math.round(e.b / e.n),
      share: e.n / total,
      count: e.n,
      luma: luma(Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)),
    }))
    // Below a quarter percent a colour is anti-aliasing noise, not a token.
    .filter((c) => c.share >= 0.0025)
    .sort((a, b) => b.share - a.share);

  const covered = colours.reduce((s, c) => s + c.share, 0);

  if (asJson) {
    console.log(
      JSON.stringify(
        { input, seconds: Number(seconds ?? 0), width, height, covered, colours },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`frame ${input} @ ${seconds ?? 0}s  ${width}x${height}`);
  console.log(`distinct colours above 0.25% coverage: ${colours.length} (${(covered * 100).toFixed(1)}% of frame)\n`);
  console.log('  share      luma  colour');
  console.log('  ------------------- --------');
  for (const c of colours) {
    console.log(
      `  ${(c.share * 100).toFixed(2).padStart(6)}%  ${c.luma.toFixed(2)}  ${c.hex}` +
        `  rgb(${c.r},${c.g},${c.b})`,
    );
  }
}

main().catch((e) => {
  console.error(`measure-frame: ${e.message}`);
  process.exit(1);
});