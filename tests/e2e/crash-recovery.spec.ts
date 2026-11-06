/**
 * Crash recovery.
 *
 * The original prompt's success bar requires this: "zero data-loss bugs in the
 * crash-recovery test" — kill the app mid-typing, reopen, and assert that at
 * most the last second of typing is lost and the document tree is still valid.
 *
 * Two properties are being checked, and they are not the same thing:
 *
 *   1. **The tree is valid.** A crash that leaves an orphaned block or a
 *      half-written row is a data-loss bug, and it is worse than losing the
 *      last few keystrokes.
 *   2. **The loss is bounded at the tail.** What survived must be a *prefix* of
 *      what was typed. A crash that leaves a gap in the middle — the first half
 *      of a sentence, then the last half — means the write interleaved with
 *      the typing, and that is corruption rather than truncation.
 *
 * The kill is a hard process kill, not a graceful close, because a graceful
 * close flushes and proves nothing.
 */

import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const electronMain = join(process.cwd(), 'apps', 'desktop', 'dist', 'main', 'index.js');

/** Kill the whole process tree, hard. A graceful close would flush and prove nothing. */
function killHard(app: ElectronApplication): void {
  const pid = app.process()?.pid;
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

async function launch(workspace: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [electronMain],
    env: { ...process.env, OW_WORKSPACE: workspace, OW_USER_DATA: mkdtempSync(join(tmpdir(), 'ow-crash-')) },
  });
  const window = await app.firstWindow();
  await window.bringToFront();
  await window.waitForSelector('.ow-app');
  return { app, window };
}

test('a hard kill mid-typing loses only the tail, and the tree stays valid', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'ow-crash-ws-'));
  const typed = 'the quick brown fox jumps over the lazy dog and keeps on running';

  let app: ElectronApplication | undefined;
  try {
    const first = await launch(workspace);
    app = first.app;

    // Seed a page and start typing into it.
    await first.window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ value: { id: string } }> };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Crash test' });
      await bridge.execute('page.open', { id: page.value.id });
      await bridge.execute('block.insert', { type: 'paragraph', text: '' });
    });

    const editor = first.window.locator('.ow-block-text').first();
    await editor.click();
    // Type a real sentence. The point is a plausible document, not a marker.
    await editor.type(typed, { delay: 5 });

    // Kill it mid-flight, without letting the app flush.
    killHard(app);
    app = undefined;

    // Reopen against the same workspace.
    const second = await launch(workspace);
    app = second.app;

    const recovered = await second.window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: {
            execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: unknown }>;
            state(): Promise<{ integrity: { ok: boolean; problems: string[] }; current: { rows: { text: string }[] } }>;
          };
        }
      ).ow;
      const state = await bridge.state();
      const check = await bridge.execute('__integrity__', {});
      return {
        integrity: state.integrity,
        text: state.current.rows
          .map((r) => r.text)
          // The page seeds an empty block, and joining with a newline would put
          // a leading break in front of the recovered text and make the prefix
          // check fail for a reason that has nothing to do with the crash.
          .filter((t) => t.length > 0)
          .join(''),
        checkOk: check.ok,
      };
    });

    // 1. The tree is valid. This is the data-loss property: a crash that leaves
    //    an orphaned block or a broken parent is a bug, not a lost keystroke.
    expect(recovered.integrity.ok, `integrity problems: ${recovered.integrity.problems.join('; ')}`).toBe(true);

    // 2. What survived is a prefix of what was typed. A gap in the middle would
    //    mean the write interleaved with the typing.
    const survived = recovered.text;
    expect(typed.startsWith(survived), `survived "${survived}" is not a prefix of the typed text`).toBe(true);

    // 3. The loss is bounded. The autosave interval is 400 ms, so at most a
    //    short tail can be missing. Everything lost would mean the write never
    //    happened at all, which is a different bug.
    expect(typed.length - survived.length).toBeLessThanOrEqual(40);
  } finally {
    if (app) await app.close().catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
  }
});
