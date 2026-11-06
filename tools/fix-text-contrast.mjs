#!/usr/bin/env node
/**
 * Raise the muted and faint text tokens until they are readable.
 *
 * `tools/check-contrast.mjs` found --ow-text-muted at 2.44:1 and --ow-text-faint
 * at 1.89:1 against the page background. Both are used for things people read --
 * section labels, column headers, menu descriptions, placeholders -- and the
 * block drag handle itself is painted in faint. A screenshot confirmed it before
 * any of this was measured: the database column headers were visibly harder to
 * read than the row titles beside them.
 *
 * The colours below are not hand-picked. Each is found by walking the token's own
 * hue and saturation toward the luminance that clears the target on its worst
 * background, and stopping at the first one that does. That keeps the change as
 * small as the requirement allows: the token moves exactly as far as it has to,
 * so muted stays visibly quieter than body text instead of being flattened to the
 * same grey. Hand-picking would have drifted toward whatever looked reasonable,
 * which is how a muted token quietly becomes a body token.
 *
 * Usage: node tools/fix-text-contrast.mjs [--write]
 * Without --write it prints what it would change.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast } from './check-contrast.mjs';

const WRITE = process.argv.includes('--write');

function parseHex(hex) {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

const toHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function hueToRgb(p, q, t) {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

function hslToRgb({ h, s, l }) {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hueToRgb(p, q, h + 1 / 3) * 255,
    g: hueToRgb(p, q, h) * 255,
    b: hueToRgb(p, q, h - 1 / 3) * 255,
  };
}

/**
 * The darkest -- in light, lightest in dark -- colour at this hue and saturation
 * that clears `target` against every background in `against`.
 *
 * Searching one direction matters. Raising a faint token in a dark theme makes it
 * more legible, but raising it in a light theme makes it *less* legible, so the
 * direction is "away from the background", not "up".
 */
function solve(startHex, against, target) {
  const { h, s } = rgbToHsl(parseHex(startHex));
  const start = rgbToHsl(parseHex(startHex)).l;
  const direction = against[0] && parseHex(against[0]) && isLight(against[0]) ? -1 : 1;

  let best = startHex;
  let bestRatio = Math.min(...against.map((bg) => contrast(startHex, bg)));

  for (let step = 1; step <= 100; step += 1) {
    const l = start + direction * (step / 100);
    if (l <= 0 || l >= 1) break;
    const candidate = toHex(hslToRgb({ h, s, l }));
    const ratio = Math.min(...against.map((bg) => contrast(candidate, bg)));
    if (ratio >= target) return { hex: candidate, ratio, moved: Math.abs(l - start) };
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = candidate;
    }
  }
  return { hex: best, ratio: bestRatio, moved: Math.abs(rgbToHsl(parseHex(best)).l - start) };
}

function isLight(hex) {
  return contrast(hex, '#ffffff') < contrast(hex, '#000000');
}

const path = join(process.cwd(), 'design', 'tokens.json');
const tokens = JSON.parse(readFileSync(path, 'utf8'));

const PLAN = [
  {
    token: 'textMuted',
    target: 4.5,
    against: ['bg', 'bgSidebar', 'bgOverlay', 'bgCode'],
    why:
      'Section labels, column headers, menu descriptions and database cells. All ' +
      'reading material at 14-16px, so WCAG AA normal text applies. At 2.44:1 this ' +
      'was the dimmest thing on the page that anyone is meant to read.',
  },
  {
    token: 'textFaint',
    target: 3.0,
    against: ['bg', 'bgSidebar'],
    why:
      'Block drag handle, disclosure chevrons, menu group labels and column counts. ' +
      'Affordances rather than prose, so the large-text 3:1 figure applies. Held below ' +
      'textMuted on purpose so the two tokens stay doing different jobs.',
  },
];

const changes = [];

for (const theme of ['light', 'dark']) {
  const flat = tokens.color[theme];
  for (const plan of PLAN) {
    const start = flat[plan.token].value;
    const backgrounds = plan.against.map((name) => flat[name].value);
    const solved = solve(start, backgrounds, plan.target);
    const before = backgrounds.map((bg) => contrast(start, bg));
    const after = backgrounds.map((bg) => contrast(solved.hex, bg));

    changes.push({
      theme,
      token: plan.token,
      start,
      end: solved.hex,
      before: Math.min(...before),
      after: Math.min(...after),
      target: plan.target,
      why: plan.why,
    });
  }
}

console.log('text contrast corrections');
console.log('');
for (const c of changes) {
  const ok = c.after >= c.target;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.theme.padEnd(5)} ${c.token}`);
  console.log(`         ${c.start} -> ${c.end}`);
  console.log(
    `         worst background: ${c.before.toFixed(2)}:1 -> ${c.after.toFixed(2)}:1  (needs ${c.target})`,
  );
  console.log('');
}

if (WRITE) {
  for (const c of changes) {
    const entry = tokens.color[c.theme][c.token];
    entry.value = c.end;
    entry.measured = false;
    entry.note =
      `Derived, not sampled. Raised from ${c.start} by walking lightness at the same ` +
      `hue and saturation until the worst background clears ${c.target}:1 (now ` +
      `${c.after.toFixed(2)}:1, was ${c.before.toFixed(2)}:1). ${c.why} ` +
      `Verified by tools/check-contrast.mjs, which is why this is not a hand-picked grey.`;
  }
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`);
  console.log(`wrote ${path}`);
  console.log('now run: node tools/xtask/generate-tokens.mjs');
} else {
  console.log('dry run. pass --write to apply.');
}