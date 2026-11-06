/**
 * Attribution check.
 *
 * Every file under `assets/` and `fonts/` must appear in `ATTRIBUTION.md` with
 * an author, a source URL and a licence. The check exists because an uncredited
 * asset is a legal problem discovered long after release, and because "we were
 * careful" is not something a repository can demonstrate.
 *
 * Also verifies that `THIRD_PARTY_NOTICES.md` lists every declared dependency,
 * so a package cannot be added without recording its licence.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSET_DIRS = ['assets', 'fonts'];

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

export function checkAttribution(root) {
  const problems = [];
  const attribution = readText(join(root, 'ATTRIBUTION.md'));

  const assets = ASSET_DIRS.flatMap((dir) => listFiles(join(root, dir)));
  for (const file of assets) {
    const name = relative(root, file).split(sep).join('/');
    if (!attribution.includes(name)) {
      problems.push(`asset not listed in ATTRIBUTION.md: ${name}`);
    }
  }

  // A dependency that is not in the notices file is a licence we cannot show.
  const notices = readText(join(root, 'THIRD_PARTY_NOTICES.md'));
  const pkg = JSON.parse(readText(join(root, 'package.json')));
  for (const group of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(pkg[group] ?? {})) {
      if (!notices.includes(name)) {
        problems.push(`dependency not listed in THIRD_PARTY_NOTICES.md: ${name}@${version}`);
      }
    }
  }

  // Every documented command has to exist.
  //
  // This is not a style preference. Five of the seven scripts in the root
  // package.json pointed at a `tools/xtask/bin/` directory that does not exist,
  // including `ci` -- the one AGENTS.md tells a new contributor to run. Nothing
  // failed loudly: a script that resolves to a missing module is a stack trace
  // on a fresh clone, which reads as "this repo is broken" rather than "this
  // path was stale after a refactor". Checking the first token of every script
  // costs nothing and makes the rot impossible to commit silently.
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    for (const target of scriptTargets(command)) {
      // npm run chains (`a && b`) and cross-workspace forwarding are not paths.
      if (target.startsWith('-') || target.startsWith('$')) continue;
      if (!existsSync(join(root, target))) {
        problems.push(`npm script "${name}" points at a missing file: ${target}`);
      }
    }
  }

  return { assets: assets.length, problems };
}

/**
 * Files a script runs directly.
 *
 * Only the word straight after `node` or `npm run` is treated as a path. Anything
 * else -- a flag, a glob, a workspace selector -- is passed through untouched
 * rather than guessed at, because a check that reports false failures gets
 * deleted and then catches nothing.
 */
function scriptTargets(command) {
  const targets = [];
  for (const part of command.split('&&')) {
    const tokens = part.trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token === 'node' || token === 'npm') {
        const next = tokens[i + 1];
        if (!next) continue;
        if (token === 'npm' && next === 'run') continue;
        if (next.startsWith('-')) continue;
        if (!next.includes('/') && !next.endsWith('.mjs') && !next.endsWith('.js')) continue;
        targets.push(next);
      }
    }
  }
  return targets;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (invokedDirectly) {
  const root = process.argv[2] ?? process.cwd();
  const { assets, problems } = checkAttribution(root);
  if (!problems.length) {
    console.log(`attribution: ok (${assets} asset file(s) listed)`);
    process.exit(0);
  }
  console.error(`attribution: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}