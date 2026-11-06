/**
 * Layering check.
 *
 * Enforces the rule that a package may only import from lower layers:
 *
 *   L0 geom < L1 model/text/db-engine < L2 storage/formats < L3 commands
 *        < L4 automation < L5 ui-kit/editor-ui < L6 app-ui < L7 apps
 *
 * Why this is worth automating rather than documenting: a stray import of
 * `app-ui` into `model` compiles perfectly and produces a bundle that cannot be
 * tested headlessly, which is exactly the property this architecture exists to
 * protect. The failure mode stays invisible until someone needs a CLI.
 *
 * Also rejects a relative import that escapes its own package, because two
 * packages fused by a `../../` are no longer separable and no longer testable.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAYERS = {
  geom: 0,
  model: 1,
  text: 1,
  'db-engine': 1,
  formula: 1,
  storage: 2,
  formats: 2,
  commands: 3,
  automation: 4,
  'ui-kit': 5,
  'editor-ui': 5,
  'app-ui': 6,
};

/** Packages with no layer of their own: they sit above everything. */
const APPS = new Set(['desktop', 'web', 'cli']);
const APP_LAYER = 99;

function layerOf(name) {
  if (Object.prototype.hasOwnProperty.call(LAYERS, name)) return LAYERS[name];
  if (APPS.has(name)) return APP_LAYER;
  return null;
}

/** Match static and side-effect imports in a TypeScript source file. */
const IMPORT_RE =
  /(?:^|[^\w$])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w$])import\s*['"]([^'"]+)['"]/g;

export function checkLayering(root) {
  const violations = [];

  for (const pkg of listPackages(root)) {
    const fromLayer = layerOf(pkg);
    if (fromLayer === null) continue;

    for (const file of listSources(join(root, 'packages', pkg))) {
      const rel = relative(root, file).split(sep).join('/');
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(IMPORT_RE)) {
        const spec = match[1] ?? match[2];
        if (!spec) continue;
        const line = source.slice(0, match.index).split('\n').length;

        const target = /^@ow\/([a-z-]+)$/.exec(spec)?.[1] ?? null;
        if (!target) {
          if (spec.startsWith('.') && escapesPackage(root, pkg, file, spec)) {
            violations.push({
              file: rel,
              line,
              from: pkg,
              to: spec,
              reason: 'relative import escapes the package directory',
            });
          }
          continue;
        }
        if (target === pkg) continue;
        const toLayer = layerOf(target);
        if (toLayer === null) continue;
        if (fromLayer === APP_LAYER) continue; // apps may import anything
        if (toLayer > fromLayer) {
          violations.push({
            file: rel,
            line,
            from: pkg,
            to: target,
            reason: `L${fromLayer} must not import L${toLayer}`,
          });
        }
      }
    }
  }
  return violations;
}

function listPackages(root) {
  const base = join(root, 'packages');
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((name) => statSync(join(base, name)).isDirectory());
}

function listSources(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listSources(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Whether a relative import points outside its own package.
 *
 * Resolved with `path.resolve` rather than by counting `..` segments: counting
 * has to know the file's depth, gets it wrong as soon as a package has a nested
 * directory, and either misses real violations or reports false ones.
 */
function escapesPackage(root, pkg, file, spec) {
  const packageRoot = resolve(join(root, 'packages', pkg));
  const target = resolve(dirname(file), spec);
  // The trailing separator matters: without it, `packages/model-extra` would be
  // treated as living inside `packages/model`.
  return !target.startsWith(packageRoot + sep);
}

/**
 * Run from the command line. Exit code 1 on any violation.
 *
 * The entry check compares resolved paths rather than URL strings: a project
 * path containing a space is percent-encoded in `import.meta.url`, so a string
 * comparison silently never matches and the script appears to do nothing.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invokedDirectly) {
  const root = process.argv[2] ?? process.cwd();
  const violations = checkLayering(root);
  if (!violations.length) {
    console.log('layering: ok');
    process.exit(0);
  }
  console.error(`layering: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.from} -> ${v.to}: ${v.reason}`);
  }
  process.exit(1);
}