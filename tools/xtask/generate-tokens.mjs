#!/usr/bin/env node
/**
 * Generate CSS custom properties from `design/tokens.json`.
 *
 * Why generate rather than hand-write CSS variables: two sources of truth is the
 * single most common cause of a design system drifting. Someone edits the token
 * file, forgets the CSS, and two components disagree about what "border" means.
 * Here the JSON is the only thing anyone edits.
 *
 * The generator also enforces a rule the JSON cannot express on its own: a token
 * marked `"approx": true` MUST have `approx: true` emitted in its CSS comment.
 * That way an unmeasured value is visible at the point of use, in devtools, not
 * only in the file that produced it. Silently shipping a guessed colour as if it
 * were measured is exactly the failure this project is trying to avoid.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const tokensPath = join(root, 'design', 'tokens.json');
const outPath = join(root, 'packages', 'ui-kit', 'src', 'tokens.css');

const tokens = JSON.parse(readFileSync(tokensPath, 'utf8'));

/** Turn `bgSidebar` into `--ow-bg-sidebar`. */
function cssVarName(path) {
  return `--ow-${path
    .map((segment, i) =>
      i === 0
        ? segment.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`)
        : segment.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`),
    )
    .join('-')}`;
}

const lines = [];
const emit = (indent, path, entry) => {
  if (typeof entry !== 'object' || entry === null) return;
  const value = entry.value;
  if (value === undefined) return;
  const comments = [];
  if (entry.approx) comments.push('APPROX -- not measured, see design/measurements.md');
  if (entry.note) comments.push(entry.note);
  const suffix = comments.length ? ` /* ${comments.join(' | ')} */` : ' /* measured */';
  lines.push(`${indent}${cssVarName(path)}: ${value};${suffix}`);
};

/**
 * Walk a token group, skipping meta keys.
 *
 * Two shapes exist: leaf nodes with a `value`, and groups with `px`/`1`/`2`
 * members. Both are flattened into the same namespace, which is why `space.1`
 * and `size.1` never collide.
 */
function walk(node, prefix, depth) {
  for (const [key, entry] of Object.entries(node)) {
    if (key.startsWith('$') || key === 'value' || key === 'note' || key === 'approx' || key === 'measured' || key === 'use' || key === 'lineHeight') {
      continue;
    }
    const path = [...prefix, key];
    if (entry && typeof entry === 'object' && entry.value !== undefined) {
      emit('  '.repeat(depth), path, entry);
      continue;
    }
    // A group. `space.px` is a plain string rather than an object.
    if (typeof entry === 'string') {
      lines.push(`${'  '.repeat(depth)}${cssVarName(path)}: ${entry}; /* measured */`);
      continue;
    }
    if (entry && typeof entry === 'object') {
      if (depth > 0) {
        lines.push(`${'  '.repeat(depth)}/* ${path.join('.')} */`);
      }
      walk(entry, path, depth + 1);
    }
  }
}

lines.push('/**');
lines.push(' * Design tokens. GENERATED FILE -- do not edit.');
lines.push(' *');
lines.push(' * Source of truth: design/tokens.json. Regenerate with:');
lines.push(' *   node tools/xtask/generate-tokens.mjs');
lines.push(' *');
lines.push(' * Each declaration carries a comment saying whether the value was');
lines.push(' * MEASURED out of reference footage or is APPROX. Approx values are');
lines.push(' * ours, not parity, and must not be presented as matching the reference.');
lines.push(' */');
lines.push(':root {');
// Light colours are the unprefixed defaults, so components reference --ow-bg
// and never need to know which theme is active. The dark block below simply
// redefines the same names. Prefixing them per theme would force every component
// to branch on the theme, which is the mistake this shape avoids.
walk(tokens.color.light, [], 1);
lines.push('}');

lines.push('');
lines.push('/* Everything below is theme-independent by design, so it stays in one'); 
lines.push(' * block rather than being duplicated per theme. */');
lines.push(':root {');
walk(
  {
    space: tokens.space,
    size: tokens.size,
    radius: tokens.radius,
    elevation: tokens.elevation,
    motion: tokens.motion,
    type: tokens.type,
  },
  [],
  1,
);
lines.push('}');

lines.push('');
lines.push('/* Dark theme. Measured from reference footage; see design/measurements.md. */');
lines.push(':root[data-theme="dark"] {');
walk(tokens.color.dark, [], 1);
lines.push('}');

lines.push('');
lines.push('/* Explicit light theme, for when the OS setting must be overridden. */');
lines.push(':root[data-theme="light"] {');
walk(tokens.color.light, [], 1);
lines.push('}');

mkdirSync(join(root, 'packages', 'ui-kit', 'src'), { recursive: true });
writeFileSync(outPath, `${lines.join('\n')}\n`);

const approxCount = lines.filter((l) => l.includes('APPROX')).length;
const measuredCount = lines.filter((l) => l.includes('/* measured')).length;
console.log(
  `tokens: wrote ${outPath.replace(root + '\\', '')} ` +
    `(${measuredCount} measured, ${approxCount} approximate)`,
);