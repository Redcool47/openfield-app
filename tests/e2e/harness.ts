/**
 * Launch helpers for e2e tests.
 *
 * Each test gets its own workspace directory. That is not tidiness: Electron's
 * `--user-data-dir` is not honoured by this build, so without an explicit
 * override every test opens the *real* workspace and writes into it. Tests then
 * accumulate each other's pages, and an assertion like "exactly one block here"
 * fails on the second run for a reason that has nothing to do with the code.
 *
 * It also means a test run can no longer damage whatever you actually have open.
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const electronMain = join(process.cwd(), 'apps', 'desktop', 'dist', 'main', 'index.js');

export interface TestApp {
  app: ElectronApplication;
  window: Page;
  /**
   * Remove the throwaway workspace.
   *
   * Awaited, and that is the whole point: Electron still holds the SQLite file
   * after `close()` is merely *called*, and `rmSync` then fails with EPERM on
   * Windows. The previous version did not await and left temp directories
   * behind, one per test per run.
   */
  cleanup(): Promise<void>;
}

/**
 * Launch the app against a fresh workspace and wait for the shell.
 *
 * The window is not resized: the layout is responsive and several assertions
 * read geometry relative to the viewport.
 */
export async function launchApp(): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'ow-e2e-'));
  const profile = mkdtempSync(join(tmpdir(), 'ow-profile-'));
  const app = await electron.launch({
    args: [electronMain],
    // Two directories, not one. OW_WORKSPACE is the document database; OW_USER_DATA
    // is the Chromium profile, which is where preferences live in localStorage.
    // Sharing one profile across every launch meant a preference from an earlier
    // run was still in place for the next, and one launch's profile lock made the
    // next fail with ECONNRESET.
    env: { ...process.env, OW_WORKSPACE: dir, OW_USER_DATA: profile },
  });
  const window = await app.firstWindow();
  await window.bringToFront();
  await window.waitForSelector('.ow-app');
  return {
    app,
    window,
    /** The workspace directory, so a test can look at the files on disk. */
    dir,
    async cleanup() {
      await app.close().catch(() => {});
      // Best effort: a crash can leave a handle open, and a leaked temp
      // directory is a far smaller problem than a failed test run.
      for (const d of [dir, profile]) {
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
          // ignore
        }
      }
    },
  };
}

/**
 * Open the settings dialog.
 *
 * Settings moved out of the sidebar body and behind one control: six labelled
 * control groups stacked under the page tree made the sidebar read as a settings
 * panel with a page list wedged into it. Tests that reach for a control have to
 * open it first, and forgetting that is the whole reason this helper exists.
 */
export async function openSettings(window: Page, section?: string): Promise<void> {
  await window.locator('.ow-settings-open').click();
  await window.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
  // The dialog has a navigation rail, so a section has to be opened before its
  // controls exist. Naming the section here keeps that out of every test.
  if (section) {
    await window.getByRole('tab', { name: section }).click();
  }
}

/**
 * Seed a page with blocks and open it, through the command bridge.
 *
 * Every e2e that asserts on page contents wants a page it owns. Reaching for
 * "the first block" in whatever page happens to be open is how a test starts
 * failing because a different test ran first.
 */
export async function seedPage(
  window: Page,
  title: string,
  blocks: { type: string; text: string }[] = [],
): Promise<void> {
  await window.evaluate(
    async ([pageTitle, specs]) => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, args?: unknown) => Promise<{ ok: boolean; value: { id: string } }> };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: pageTitle as string });
      await bridge.execute('page.open', { id: page.value.id });
      for (const spec of specs as { type: string; text: string }[]) {
        await bridge.execute('block.insert', { type: spec.type, text: spec.text });
      }
    },
    [title, blocks] as const,
  );
}