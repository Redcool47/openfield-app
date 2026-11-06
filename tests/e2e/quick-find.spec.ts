/**
 * Quick find.
 *
 * The assertion that matters is that Enter opens the *right* page. An earlier
 * version of this test failed on exactly that, and the fault was in the product:
 * the hit's id field is `pageId`, so reading `id` passed `undefined` to
 * page.open, no page opened, and the search looked broken.
 */

import { _electron as electron, type Page } from 'playwright';
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const electronMain = join(process.cwd(), 'apps', 'desktop', 'dist', 'main', 'index.js');

// Unique per run. These launches share one workspace, so fixed titles accumulate
// and an exact count assertion fails on the second run.
const MARK = 'findmark' + Math.random().toString(36).slice(2, 8);

async function launch(): Promise<{ app: ElectronApplication; window: Page; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'ow-find-'));
  const app = await electron.launch({ args: [electronMain, '--user-data-dir', dir] });
  const window = await app.firstWindow();
  await window.bringToFront();
  await expect(window.locator('.ow-app')).toBeVisible();
  await window.evaluate(async (mark: string) => {
    const ow = (
      globalThis as unknown as {
        ow: { execute: (id: string, args?: unknown) => Promise<{ ok: boolean }> };
      }
    ).ow;
    for (const title of [mark + ' alpha', mark + ' beta', 'Unrelated']) {
      await ow.execute('page.create', { title });
    }
  }, MARK);
  return { app, window, dir };
}

test('Ctrl+P finds pages and Enter opens the one chosen', async () => {
  const { app, window, dir } = await launch();
  try {
    await window.keyboard.press('Control+p');
    await expect(window.getByRole('dialog', { name: 'Search pages' })).toBeVisible();
    // Autofocus, or the user has to click before they can type.
    await expect(window.locator('.ow-find-input')).toBeFocused();

    await window.locator('.ow-find-input').fill(MARK);
    await expect(window.locator('.ow-find-item')).toHaveCount(2, { timeout: 10_000 });

    // Arrow to the second, then open it -- proves the highlighted row is the one
    // that opens, which is the whole contract of a list.
    await window.keyboard.press('ArrowDown');
    // Wait for the second row to actually become the highlighted one before
    // reading it or pressing Enter. The results are filtered asynchronously, so
    // an arrow that lands before the list settles moves the highlight in a list
    // that is then replaced by a fresh one with the highlight back at the top --
    // Enter then opens the first row while the test is reading the second.
    await expect(window.locator('.ow-find-item').nth(1)).toHaveAttribute('aria-selected', 'true');
    const chosen = (await window.locator('.ow-find-item').nth(1).textContent()) ?? '';
    await window.keyboard.press('Enter');

    await expect(window.getByRole('dialog', { name: 'Search pages' })).toBeHidden();
    await expect(window.locator('.ow-page-title')).toHaveText(chosen.trim(), { timeout: 10_000 });
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Escape closes it and an empty query lists nothing', async () => {
  const { app, window, dir } = await launch();
  try {
    await window.keyboard.press('Control+p');
    await expect(window.locator('.ow-find-input')).toBeFocused();
    // An empty query is not a search; listing the whole workspace is noise.
    await expect(window.locator('.ow-find-item')).toHaveCount(0);

    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog', { name: 'Search pages' })).toBeHidden();
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
