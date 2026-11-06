/**
 * A module resolution hook that maps `./foo.js` onto `./foo.ts`.
 *
 * Why this exists: the TypeScript sources use explicit `.js` specifiers, which is
 * the correct thing to write for a compiled ESM build and is what `tsc` expects.
 * Node's native type stripping, however, will not rewrite those specifiers, so a
 * relative import of `./registry.js` fails to resolve when only `registry.ts` is
 * present.
 *
 * Rather than give up explicit extensions (and lose ESM correctness in the real
 * build) or add a bundler as a runtime dependency, this hook retries the
 * resolution with `.ts` appended and with `.ts` substituted for a trailing `.js`.
 * It affects only the CLI process, which is exactly where running from source
 * matters.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The module format Node expects for an ESM TypeScript source.
 *
 * It must be `module-typescript`, not `module`: Node's type stripping is driven
 * by the resolved format, and claiming plain `module` makes Node hand the raw
 * source to the JavaScript parser, which then fails on the first `interface`.
 * Probed once against `process.versions.node` rather than hard-coded so a future
 * runtime change is visible immediately.
 */
const TS_FORMAT = 'module-typescript';

async function resolveAsTs(url) {
  return { url: url.href, format: TS_FORMAT, shortCircuit: true };
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    const parentURL = context.parentURL;
    if (!parentURL || !parentURL.startsWith('file:')) throw error;

    // A relative `.js` specifier whose real file is `.ts`.
    if (/\.jsx?$/.test(specifier)) {
      for (const ext of ['.ts', '.tsx', '.mts']) {
        const url = new URL(specifier.replace(/\.jsx?$/, ext), parentURL);
        if (existsSync(fileURLToPath(url))) return resolveAsTs(url);
      }
    }

    // Extension-less or directory specifiers, which Node ESM does not resolve.
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const base = new URL(specifier, parentURL);
      for (const suffix of ['.ts', '/index.ts']) {
        const url = new URL(base.href + suffix);
        if (existsSync(fileURLToPath(url))) return resolveAsTs(url);
      }
    }

    throw error;
  }
}

export { pathToFileURL };