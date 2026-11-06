#!/usr/bin/env node
/**
 * `ow` entry point.
 *
 * Registers the `.js` -> `.ts` resolution hook, then imports the CLI from
 * source. This means the CLI runs against the same code the tests exercise,
 * with no separate build step to keep in sync.
 */

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The built-in SQLite driver reports itself as experimental on every start.
 * That warning lands on stderr ahead of our own output and makes ow ... > out
 * confusing, so it is filtered here rather than left for the caller to ignore.
 * Every other warning is still shown.
 */
const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const name = typeof warning === 'object' && warning !== null ? warning.name : rest[0];
  if (name === 'ExperimentalWarning') return;
  emit.call(process, warning, ...rest);
};

const here = dirname(fileURLToPath(import.meta.url));
register('./ts-resolver.mjs', pathToFileURL(join(here, 'placeholder')));

const { main } = await import('../src/ow.ts');

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`ow: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}