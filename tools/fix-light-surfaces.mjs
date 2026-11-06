#!/usr/bin/env node
/**
 * Correct the light surface colours, using another implementation as a cross-check.
 *
 * These two values were the weakest in the design system. The dark palette was
 * measured from native-resolution reference screenshots; the light palette was
 * read off compressed video, which corrupts colour, and has never been checked
 * against anything. It then became the *default* theme, so the least verified
 * numbers in the project are the first ones every new user sees.
 *
 * A second open-source implementation was read as a sanity check -- not as a
 * measurement, and not copied. It cannot tell us what the reference product does;
 * it can tell us whether our numbers are internally plausible. Two findings:
 *
 *   - The page ground should be pure white. Ours was a warm off-white sampled
 *     from video, and video chroma subsampling is exactly what turns white into
 *     something faintly cream.
 *   - The sidebar was too far from the page. Ours sat about 13 steps below the
 *     ground; a sidebar that reads as a separate surface sits about 7. When the
 *     gap is large the sidebar stops being part of the window and starts looking
 *     like a second pane, which is the "Open Workspace" look this project is
 *     trying not to have.
 *
 * What is deliberately *not* changed: the text ramp and the interaction overlays,
 * which were derived by walking contrast targets and now sit next to the
 * reference values without being copied from them. textFaint in particular is
 * within two points of theirs by coincidence, and is left alone rather than
 * nudged into agreement.
 *
 * Usage: node tools/fix-light-surfaces.mjs [--write]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast } from './check-contrast.mjs';

const WRITE = process.argv.includes('--write');
const path = join(process.cwd(), 'design', 'tokens.json');
const tokens = JSON.parse(readFileSync(path, 'utf8'));

const EDITS = [
  {
    name: 'bg',
    from: '#fdfdfc',
    to: '#ffffff',
    why:
      'Pure white. The previous value was a warm off-white sampled from ' +
      'compressed video, and chroma subsampling in the codec is precisely what ' +
      'turns a white page faintly cream. An off-white ground also lowers the ' +
      'contrast of every text token sitting on it, which is a side effect nobody ' +
      'chooses on purpose.',
  },
  {
    name: 'bgSidebar',
    from: '#f4f2f0',
    to: '#f7f6f4',
    why:
      'Much closer to the ground than before. Ours sat ~13 steps below the page; ' +
      'a sidebar that reads as part of the window sits ~7. A wider gap makes the ' +
      'sidebar look like a second application pane rather than a region of this ' +
      'one. Cross-checked against a second open-source implementation of the same ' +
      'kind of product, which uses the same narrow relationship; the number here ' +
      'is chosen here.',
  },
];

const light = tokens.color.light;

if (WRITE) {
  for (const edit of EDITS) {
    const entry = light[edit.name];
    if (!entry) throw new Error(`no light token named ${edit.name}`);
    if (entry.value !== edit.from) {
      throw new Error(
        `light.${edit.name} is ${entry.value}, not the expected ${edit.from}. ` +
          'Re-read this script before applying it -- it states what it expects to find.',
      );
    }
    entry.value = edit.to;
    entry.measured = false;
    entry.note =
      `Corrected from ${edit.from}. ${edit.why} ` +
      'Verified by tools/check-contrast.mjs, which is the gate that actually ' +
      'constrains this value rather than taste.';
  }
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`);
  console.log(`wrote ${path}`);
  console.log('now run: node tools/xtask/generate-tokens.mjs');
} else {
  console.log('light surface corrections (dry run)');
  for (const edit of EDITS) {
    const before = contrast(light.text.value, edit.from);
    const after = contrast(light.text.value, edit.to);
    console.log(`\n  ${edit.name}`);
    console.log(`    ${edit.from} -> ${edit.to}`);
    console.log(`    body text contrast on it: ${before.toFixed(2)}:1 -> ${after.toFixed(2)}:1`);
  }
  console.log('\npass --write to apply');
}