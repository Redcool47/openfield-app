#!/usr/bin/env node
/**
 * Correct the interaction and surface tokens, and record why.
 *
 * Three problems, found by reading someone else's stylesheet rather than by
 * staring at mine:
 *
 * 1. bgSidebar was a copy of bg with a note admitting the delta could not be
 *    isolated. It can be: measured from two reference screenshots, independently
 *    of each other, both agreeing on #202020 against #191919 for the page. A
 *    token carrying an admission it might be wrong is worse than a wrong token,
 *    because the note is where someone stops looking.
 *
 * 2. Hover, selected and active were solid hex values. That means one token per
 *    state per surface, and it breaks the moment a surface is not exactly the
 *    colour the token was sampled from -- a tinted panel, a hover inside a
 *    selected row, a card on a hover. An alpha overlay composites correctly on
 *    whatever is behind it, so one token works everywhere. This is the single
 *    biggest reason my UI has looked off while feeling right.
 *
 * 3. One shadow value for every elevation. A single shadow reads as a sticker:
 *    it either separates or it does not, with nothing in between. Two layers --
 *    a tight contact shadow and a wide ambient one -- is what makes a surface
 *    look lifted off the page rather than pasted onto it.
 *
 * Plus a dedicated code background, which I was faking with bgActive -- correct
 * for a selected row and far too light for a code panel.
 *
 * The values here are chosen here. What was taken from elsewhere is the
 * observation that interaction states should be alpha overlays and shadows
 * should have depth; both are ordinary practice, not anyone's invention.
 *
 * Usage: node tools/fix-interaction-tokens.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const path = join(process.cwd(), 'design', 'tokens.json');
const tokens = JSON.parse(readFileSync(path, 'utf8'));

const NOTE =
  'An alpha overlay rather than a solid colour, so the same token composites ' +
  'correctly on any surface instead of needing one value per background.';

const SHADOW_NOTE =
  'Two layers: a tight contact shadow and a wide ambient one. A single value ' +
  'reads as a sticker rather than a lifted surface.';

const edits = [];

/**
 * The sidebar is a distinct surface, measured -- not assumed.
 *
 * Two reference screenshots, sampled independently, agree. Recorded per region so
 * the next reader can reproduce the number instead of taking it on trust.
 */
tokens.color.dark.bgSidebar = {
  value: '#202020',
  measured: true,
  note:
    'Measured from two reference screenshots at 2x (analysis/ref/database-screenshot.png ' +
    'and analysis/ref/block-types.png): sidebar #202020 against page #191919. Supersedes ' +
    'a copy of the page colour that carried a note admitting the delta was unisolated.',
};

edits.push(['dark.bgSidebar', '#171716 (copy of bg)', '#202020 (measured)']);

// Interaction states become overlays.
tokens.color.light.bgHover = { value: 'rgba(16, 16, 24, 0.05)', measured: false, note: NOTE };
tokens.color.light.bgSelected = { value: 'rgba(16, 16, 24, 0.085)', measured: false, note: NOTE };
tokens.color.light.bgActive = { value: 'rgba(16, 16, 24, 0.13)', measured: false, note: NOTE };

// Dark needs a light overlay: darkening a dark surface makes it muddy, and the
// whole point of an overlay is that it moves the surface toward its text.
tokens.color.dark.bgHover = { value: 'rgba(255, 255, 255, 0.055)', measured: false, note: NOTE };
tokens.color.dark.bgSelected = { value: 'rgba(255, 255, 255, 0.09)', measured: false, note: NOTE };
tokens.color.dark.bgActive = { value: 'rgba(255, 255, 255, 0.14)', measured: false, note: NOTE };

edits.push(
  ['light.bgHover', '#f1f1f0 (solid)', 'rgba(16,16,24,0.05) overlay'],
  ['dark.bgHover', '#262626 (solid)', 'rgba(255,255,255,0.055) overlay'],
  ['dark.bgActive', '#464748 (solid)', 'rgba(255,255,255,0.14) overlay'],
);

// Elevation gains a middle tier and gains depth.
tokens.elevation = {
  $comment:
    'Shadows are layered: a tight contact shadow that grounds the surface and a ' +
    'wide ambient one that separates it from the page. One value cannot do both.',
  popover: {
    value:
      '0 1px 2px rgba(0, 0, 0, 0.08), 0 10px 28px rgba(0, 0, 0, 0.14)',
    measured: false,
    note: SHADOW_NOTE,
  },
  modal: {
    value:
      '0 2px 6px rgba(0, 0, 0, 0.12), 0 28px 64px rgba(0, 0, 0, 0.24)',
    measured: false,
    note: SHADOW_NOTE,
  },
};
edits.push(['elevation', 'one shadow value', 'two layers, popover and modal']);

// A real code background, per theme. Previously faked with bgActive.
tokens.color.light.bgCode = { value: '#f6f6f5', measured: false, note: 'Code and callout panels.' };
tokens.color.dark.bgCode = { value: '#222222', measured: false, note: 'Code and callout panels.' };
edits.push(['bgCode', 'did not exist (used bgActive)', 'a real token per theme']);

writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`);

console.log('interaction tokens corrected');
for (const [what, before, after] of edits) {
  console.log(`  ${what}`);
  console.log(`      ${before}`);
  console.log(`   -> ${after}`);
}
console.log('');
console.log('now run: node tools/xtask/generate-tokens.mjs');
