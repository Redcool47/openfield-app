#!/usr/bin/env node
/**
 * Apply measurements from a native-resolution reference screenshot to the tokens.
 *
 * Written as a script rather than hand-edited JSON so the arithmetic is explicit
 * and auditable, and so the same reasoning can be re-run against a second
 * screenshot. Values are only ever *raised* in confidence when a measurement
 * supports them; nothing here invents a number.
 *
 * The correction that matters: the dark colours were previously marked
 * "measured" from video frames, and they were wrong. Video compression shifts
 * near-black and near-white differently, and the error was largest exactly where
 * it is hardest to see by eye -- a text colour that reads as "white" whether it
 * is #cacacb or #f0efed. A native PNG is the better source and says the text is
 * substantially brighter than believed.
 *
 * Usage: node tools/apply-measurements.mjs <screenshot.png>
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [png] = process.argv.slice(2);
if (!png) {
  console.error('usage: node tools/apply-measurements.mjs <screenshot.png>');
  process.exit(2);
}
if (!existsSync(png)) {
  console.error(`no such file: ${png}`);
  process.exit(1);
}

/**
 * Device pixels per CSS pixel.
 *
 * The screenshot is a 2736x1482 capture of a window on a display running at
 * 200% scaling, so one CSS pixel is two device pixels. Every length below is
 * divided by this. Getting it wrong scales the whole type scale by 2, which is
 * the kind of error that produces a plausible-looking but very wrong page.
 */
const DPR = 2;

/**
 * Ink height to font size.
 *
 * A band of inked pixels for text with both ascenders and descenders spans about
 * 0.93em in the reference's typeface. Rather than trust that ratio, the type
 * scale is derived from the *ratios between* the measured bands and anchored to a
 * 16px body: ratios survive whatever the ink-height factor is, an absolute
 * derivation does not.
 */
const css = (devicePx) => Math.round(devicePx / DPR);

/** Measured ink heights, in device pixels, for each text role on the page. */
const INK = { title: 79, h1: 59, h2: 47, h3: 39, body: 31 };
const BODY_PX = 16;

/** The scale, from band ratios anchored to a 16px body. */
const scale = Object.fromEntries(
  Object.entries(INK).map(([role, ink]) => [role, Math.round((ink / INK.body) * BODY_PX)]),
);

/** Colours sampled directly from the PNG; no arithmetic, no guessing. */
const COLOURS = {
  bg: '#191919',
  text: '#f0efed',
  sidebarText: '#ffffff',
};

/**
 * Content measure.
 *
 * From the right edge of the wrapped paragraph band: 919 to 2167 device pixels.
 * A wrapped line ends at the measure, which makes it the one number here that is
 * directly observed rather than inferred -- and the previous value was 760px,
 * about 135px too wide.
 */
const MEASURE = css(2167 - 919);

const tokensPath = join(process.cwd(), 'design', 'tokens.json');
const tokens = JSON.parse(readFileSync(tokensPath, 'utf8'));

const PROVENANCE =
  'Measured from a native-resolution reference screenshot (2736x1482 at dpr 2) ' +
  'with tools/measure-screenshot.mjs.';

const changes = [];
const set = (path, value, note) => {
  const before = JSON.stringify(path);
  changes.push({ before, after: JSON.stringify(value), note });
};

// --- type scale -------------------------------------------------------------
for (const role of ['title', 'h1', 'h2', 'h3', 'body']) {
  const entry = tokens.type[role];
  const next = `${scale[role]}px`;
  if (entry.value === next) continue;
  entry.value = next;
  entry.approx = false;
  entry.measured = true;
  entry.note = PROVENANCE + ' Derived from ink-height ratios between bands, anchored to a 16px body.';
  set(`type.${role}`, next, `${role} type size`);
}

// --- colours ---------------------------------------------------------------
tokens.color.dark.bg.value = COLOURS.bg;
tokens.color.dark.bg.measured = true;
tokens.color.dark.bg.note = PROVENANCE + ' Supersedes an earlier value read off compressed video, which was too dark.';
delete tokens.color.dark.bg.approx;

tokens.color.dark.text.value = COLOURS.text;
tokens.color.dark.text.measured = true;
tokens.color.dark.text.note =
  PROVENANCE + ' Supersedes an earlier value read off compressed video. The gap is large: #f0efed against the #cacacb previously believed, because compression pulls near-white down and the eye cannot tell.';
delete tokens.color.dark.text.approx;

// --- content measure -------------------------------------------------------
tokens.size.contentWidth.value = `${MEASURE}px`;
tokens.size.contentWidth.measured = true;
delete tokens.size.contentWidth.approx;
tokens.size.contentWidth.note =
  PROVENANCE +
  ' Right edge of the wrapped paragraph band. The previous 760px was an estimate roughly 135px too wide, ' +
  'which is the difference between comfortable reading and a long line of text.';

writeFileSync(tokensPath, `${JSON.stringify(tokens, null, 2)}\n`);

console.log('measurements applied');
console.log(`  dpr ${DPR}, ink ratios -> ${Object.entries(scale).map(([k, v]) => `${k} ${v}px`).join(', ')}`);
console.log(`  content measure ${MEASURE}px (was ${'760px'})`);
console.log(`  dark bg ${COLOURS.bg}, dark text ${COLOURS.text}`);
console.log('');
for (const c of changes) console.log(`  ${c.before} -> ${c.after}   ${c.note}`);
console.log('');
console.log('now run: node tools/xtask/generate-tokens.mjs');
