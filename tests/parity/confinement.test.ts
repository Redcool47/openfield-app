/**
 * Workspace confinement.
 *
 * `ow --write-root DIR` is meant to let an agent run against one workspace and
 * nothing else. That is a safety property, and safety properties are exactly the
 * thing that gets refactored away by someone who did not know a line was load
 * bearing. So it is tested at the boundary -- a real child process, real
 * arguments -- rather than against the helper that does the comparison.
 *
 * Four of these cases are here because the naive implementation passes them all
 * and is still wrong:
 *
 *   - `..` climbing out of the root
 *   - a sibling directory whose name merely starts with the root's name
 *     (/allowed-evil against a root of /allowed), which defeats a naive
 *     string-prefix test
 *   - --read-root on its own, which looks like a read-only guarantee and is in
 *     fact no guarantee at all here, because every command in this CLI writes
 *   - two roots, which must not degrade to "last one wins"
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const ow = join(repoRoot, 'apps', 'cli', 'bin', 'ow.mjs');

let root: string;
let allowed: string;
let denied: string;
/** A sibling whose name starts with the allowed root's name. The prefix trap. */
let lookalike: string;
/**
 * Assigned in beforeAll, not at module scope: it is derived from `root`, which
 * does not exist until the suite starts. Computing it at import time throws
 * "path must be of type string, received undefined" during collection, which
 * looks like a vitest problem rather than a mistake in here.
 */
let script: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ow-confine-'));
  allowed = join(root, 'allowed');
  denied = join(root, 'denied');
  lookalike = join(root, 'allowed-evil');
  for (const dir of [allowed, denied, lookalike]) {
    mkdirSync(dir, { recursive: true });
    execFileSync(process.execPath, [ow, 'init', dir, '--name', 'T'], { encoding: 'utf8' });
  }
  script = join(root, 'mk.json');
  execFileSync(
    process.execPath,
    ['-e', `require('fs').writeFileSync(${JSON.stringify(script)}, '[{"id":"page.create","args":{"title":"Probe"}}]')`],
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Run ow, returning its combined output and exit status without throwing. */
function run(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [ow, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { out, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

describe('workspace confinement', () => {
  it('allows a workspace inside the write root', () => {
    const { out } = run(['run', '-w', allowed, '--write-root', allowed, '--script', script]);
    expect(out).toMatch(/^ok/m);
  });

  it('refuses a workspace outside every root', () => {
    const { out } = run(['run', '-w', denied, '--write-root', allowed, '--script', script]);
    expect(out).toMatch(/refusing to write/);
  });

  it('refuses to climb out of the root with ..', () => {
    const sneaky = join(allowed, '..', 'denied');
    const { out } = run(['run', '-w', sneaky, '--write-root', allowed, '--script', script]);
    expect(out).toMatch(/refusing to write/);
  });

  it('refuses a sibling directory sharing the root name as a prefix', () => {
    // The bug this exists for: /allowed-evil starts with /allowed, so a
    // string-prefix check lets it through. `relative` does not.
    const { out } = run(['run', '-w', lookalike, '--write-root', allowed, '--script', script]);
    expect(out).toMatch(/refusing to write/);
  });

  it('treats a lone read root as a boundary for writes too', () => {
    // Every command here writes, so a read-only root would constrain reads and
    // leave every write unchecked.
    const { out } = run(['run', '-w', denied, '--read-root', allowed, '--script', script]);
    expect(out).toMatch(/refusing to write/);
  });

  it('honours every root when more than one is given', () => {
    const { out } = run(['run', '-w', denied, '--write-root', allowed, '--write-root', denied, '--script', script]);
    expect(out).toMatch(/^ok/m);
  });

  it('is unrestricted when no root is given', () => {
    // Backwards compatibility: a person running ow by hand must not suddenly be
    // refused. The restriction is opt-in.
    const { out } = run(['run', '-w', denied, '--script', script]);
    expect(out).toMatch(/^ok/m);
  });

  it('still reads inside a read root', () => {
    const { out } = run(['pages', '-w', allowed, '--read-root', allowed]);
    expect(out).not.toMatch(/refusing/);
  });

  it('never created a workspace outside the roots', () => {
    // The check that matters: not merely that an error was printed, but that
    // nothing was written. A refusal after the fact would still leave the file.
    expect(existsSync(join(lookalike, 'openfield.sqlite'))).toBe(true); // created by init, not by a refused run
    const before = run(['pages', '-w', lookalike, '--json']).out;
    run(['run', '-w', lookalike, '--write-root', allowed, '--script', script]);
    const after = run(['pages', '-w', lookalike, '--json']).out;
    expect(after).toBe(before);
  });
});
