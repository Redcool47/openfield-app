#!/usr/bin/env node
/**
 * Contrast check for the token set.
 *
 * Exists because reading a token's hex value tells you nothing about whether it
 * is readable. `--ow-text-muted` at #575758 on a #191919 page looks like a
 * deliberate grey when you read the hex, and is 2.4:1 on screen -- below the
 * 4.5:1 that WCAG AA requires for body text. In the screenshot the database
 * column headers were visibly harder to read than the row titles beside them,
 * and nothing in the build said so.
 *
 * The rule applied here is deliberately split by size rather than uniform:
 *
 *   - body and larger text needs 4.5:1 (WCAG AA, normal text)
 *   - small text and text that is not the main content needs 3:1 (WCAG AA,
 *     large text, and the practical floor for anything at 12px)
 *
 * Every pair named in PAIRS is checked. A token that no pair uses cannot fail
 * this check, which is why the pair list is data rather than a loop over every
 * colour against every other colour: most combinations never appear together,
 * and a check that reports fifty irrelevant pairs gets deleted.
 *
 * Usage: node tools/check-contrast.mjs
 * Exit 0 if every pair passes, 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const tokens = JSON.parse(readFileSync(join(root, 'design', 'tokens.json'), 'utf8'));

/** Flatten { theme: { name: { value } } } to { theme: { name: hex } }. */
function flatten(theme) {
  const out = {};
  for (const [name, entry] of Object.entries(theme)) {
    if (entry && typeof entry === 'object' && typeof entry.value === 'string') {
      out[name] = entry.value;
      continue;
    }
    // One level of group, so `mark.blue` reads as `mark.blue` rather than being
    // skipped. The palette is a group because a theme may have none.
    if (entry && typeof entry === 'object') {
      for (const [key, leaf] of Object.entries(entry)) {
        if (leaf && typeof leaf === 'object' && typeof leaf.value === 'string') {
          out[`${name}.${key}`] = leaf.value;
        }
      }
    }
  }
  return out;
}

/** #rgb, #rrggbb or #rrggbbaa -> {r,g,b} 0..255. */
function parseHex(hex) {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function channel(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1..21. Order-independent. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every foreground/background pair that can actually occur, with the minimum
 * ratio each one has to reach.
 *
 * 3.0 is used for large text (WCAG AA large: >=24px, or >=18.66px bold), for
 * icons and borders, and for text that is deliberately quiet -- a column header
 * is one of those. 4.5 is WCAG AA for normal text.
 */
const PAIRS = [
  // Body copy. These are the ones that must not be quietly greyed down.
  { fg: 'text', bg: 'bg', min: 4.5, note: 'body text on the page' },
  { fg: 'text', bg: 'bgSidebar', min: 4.5, note: 'body text in the sidebar' },
  { fg: 'text', bg: 'bgOverlay', min: 4.5, note: 'body text in a popover or top bar' },
  { fg: 'text', bg: 'bgCode', min: 4.5, note: 'body text in a code panel' },
  { fg: 'text', bg: 'bgSunken', min: 4.5, note: 'body text in a sunken well' },

  // `text` on `accent` was in the first draft of this file and was removed: no
  // rule in the built stylesheet sets an accent background, so the pair cannot
  // occur. Checking it would have meant "fixing" a contrast problem that no user
  // could ever see.

  // Secondary text.
  { fg: 'textSecondary', bg: 'bg', min: 4.5, note: 'dates and secondary copy' },
  { fg: 'textSecondary', bg: 'bgSidebar', min: 4.5, note: 'secondary copy in the sidebar' },
  { fg: 'textSecondary', bg: 'bgOverlay', min: 4.5, note: 'breadcrumb text' },

  // Muted text. Deliberately quiet, but still has to be readable: a column
  // header or a table caption that a user cannot read is not a design choice.
  { fg: 'textMuted', bg: 'bg', min: 4.5, note: 'column headers and section labels' },
  { fg: 'textMuted', bg: 'bgSidebar', min: 4.5, note: 'quiet sidebar labels' },
  { fg: 'textMuted', bg: 'bgOverlay', min: 4.5, note: 'quiet labels in a popover' },
  { fg: 'textMuted', bg: 'bgCode', min: 4.5, note: 'quiet labels in a code panel' },

  // Faint text is held to 3:1, not 4.5. Its remaining uses are the block drag
  // handle, disclosure chevrons, menu group labels and column counts: shapes and
  // affordances rather than prose. Anything faint that is actually reading
  // material -- a placeholder, an "empty" caption -- belongs on textMuted
  // instead, because raising this token to 4.5 would make it indistinguishable
  // from textMuted and leave the two tokens doing one job.
  { fg: 'textFaint', bg: 'bg', min: 3.0, note: 'handles, chevrons and counts' },
  { fg: 'textFaint', bg: 'bgSidebar', min: 3.0, note: 'quiet sidebar affordances' },

  // Accent and status.
  //
  // Only accentText-on-accent is listed. `text` on `accent` was in the first
  // draft of this file and was removed: no rule in the built stylesheet sets an
  // accent background, so the pair cannot occur. Checking it would have meant
  // "fixing" a contrast problem that no user could ever see.
  { fg: 'accentText', bg: 'accent', min: 4.5, note: 'text on an accent button' },
  { fg: 'danger', bg: 'bg', min: 4.5, note: 'the trash action' },
  { fg: 'danger', bg: 'bgOverlay', min: 4.5, note: 'the trash action in a menu' },
];

/**
 * Borders, reported but never failed.
 *
 * There is no standard to hold a hairline rule to. WCAG's 3:1 applies to a
 * boundary that is the only thing identifying a control, which is not what a
 * 1px divider between table rows is; and the reference interface this project
 * is measured against uses borders faint enough that no plausible figure would
 * clear it. The first draft of this file asserted 1.3:1 and 1.8:1, which were
 * numbers invented to make the report look rigorous.
 *
 * They are printed so a change to a border token is visible in review, and are
 * explicitly not a gate.
 */
const BORDER_REPORT = [
  { fg: 'border', bg: 'bg', note: 'table row rules' },
  { fg: 'borderStrong', bg: 'bg', note: 'dividers that carry structure' },
];

/**
 * Inline colour marks, generated rather than listed.
 *
 * A hue is body copy in whatever page it is used in, so each is checked against
 * every surface text can sit on. Written as a loop because a hue added to the
 * tokens and forgotten here is exactly the case that ships unreadable.
 */
const MARK_HUES = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
for (const hue of MARK_HUES) {
  for (const surface of ['bg', 'bgSidebar', 'bgSunken']) {
    PAIRS.push({ fg: `mark.${hue}`, bg: surface, min: 4.5, note: `inline ${hue} text` });
  }
}

function main() {
  let failures = 0;
  let checked = 0;

  for (const theme of ['light', 'dark']) {
    const flat = flatten(tokens.color[theme]);
    for (const { fg, bg, min, note } of PAIRS) {
      const fgHex = flat[fg];
      const bgHex = flat[bg];
      if (!fgHex || !bgHex) {
        console.log(`  SKIP ${theme}: ${fg} on ${bg} -- token missing`);
        continue;
      }
      if (!fgHex.startsWith('#') || !bgHex.startsWith('#')) {
        // Overlay tokens are rgba and are checked as composites elsewhere; a
        // solid-on-overlay pair would be wrong, so say so rather than skip
        // silently.
        console.log(`  SKIP ${theme}: ${fg} on ${bg} -- not a solid colour (${fgHex})`);
        continue;
      }
      checked += 1;
      const ratio = contrast(fgHex, bgHex);
      const ok = ratio >= min;
      if (!ok) failures += 1;
      console.log(
        `  ${ok ? 'ok  ' : 'FAIL'} ${theme.padEnd(5)} ${(fg + ' on ' + bg).padEnd(30)} ` +
          `${ratio.toFixed(2).padStart(6)}:1  (needs ${min.toFixed(1)})  ${fgHex} on ${bgHex}  -- ${note}`,
      );
    }
  }

  console.log('');
  console.log('borders (reported, not gated -- see BORDER_REPORT in this file):');
  for (const theme of ['light', 'dark']) {
    const flat = flatten(tokens.color[theme]);
    for (const { fg, bg, note } of BORDER_REPORT) {
      if (!flat[fg] || !flat[bg]) continue;
      console.log(
        `  --   ${theme.padEnd(5)} ${(fg + ' on ' + bg).padEnd(30)} ` +
          `${contrast(flat[fg], flat[bg]).toFixed(2).padStart(6)}:1  -- ${note}`,
      );
    }
  }

  console.log('');
  if (failures > 0) {
    console.log(`contrast: ${failures} of ${checked} pair(s) below the required ratio`);
    console.log('');
    console.log('A ratio below the floor is not a taste question. Either the token is too');
    console.log('close to its background, or the floor is wrong for how the pair is used.');
    console.log('Deciding which is the point: do not quietly lower the threshold to make a');
    console.log('gate pass.');
    process.exitCode = 1;
  } else {
    console.log(`contrast: all ${checked} pairs pass`);
  }
}

// Only run when invoked directly. fix-text-contrast.mjs imports `contrast` from
// here, and a module that ran its whole report and set a process exit code on
// import made importing it look like a failing check.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main();
}