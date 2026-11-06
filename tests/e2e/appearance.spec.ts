/**
 * Appearance: the theme preference, end to end.
 *
 * This exists because the previous behaviour was untestable in a way that
 * mattered. The theme followed the operating system with no stored preference at
 * all, and the Ctrl+Shift+L chord was declared in the shortcut table from the
 * beginning with nothing behind it -- pressing it did nothing whatsoever. Both
 * looked fine in code review and neither could fail a test, because there was no
 * test.
 *
 * Three things are asserted here, and the third is the one that actually catches
 * things:
 *
 *   1. A fresh install opens light, whatever the OS says.
 *   2. The choice persists across a restart of the window.
 *   3. Storage on a `file://` origin really works.
 *
 * The third is not hypothetical. The renderer is loaded with `loadFile`, so it
 * runs on `file://` where storage can be refused, and `preferences.ts` swallows
 * that failure so the window still opens. A silent catch means "forgets your
 * setting" looks identical to "works" until a user reports the theme resetting.
 * So the test writes, reloads, and reads back.
 */

import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const electronMain = join(process.cwd(), 'apps', 'desktop', 'dist', 'main', 'index.js');

/**
 * Launch against a throwaway user-data directory.
 *
 * A fresh directory per test is what makes the default genuinely testable: with
 * a shared profile, a preference left behind by an earlier test would make the
 * "opens light" assertion pass for the wrong reason.
 */
async function launch(): Promise<{ app: ElectronApplication; window: Page; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'ow-theme-'));
  const app = await electron.launch({ args: [electronMain, '--user-data-dir', dir] });
  const window = await app.firstWindow();
  await window.bringToFront();
  await expect(window.locator('.ow-app')).toBeVisible();
  return { app, window, dir };
}

/**
 * Open the settings dialog on a section.
 *
 * The dialog has a navigation rail, so the appearance controls only exist
 * once their section is open.
 */
async function openSettings(window: Page, section: string): Promise<void> {
  await window.locator('.ow-settings-open').click();
  await window.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
  await window.getByRole('tab', { name: section }).click();
}

async function shutdown(app: ElectronApplication | undefined, dir: string): Promise<void> {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

test.describe('appearance', () => {
  test('opens light on a fresh install and persists a change', async () => {
    const { app, window, dir } = await launch();
    try {
      // The attribute goes on <html>, not on the app element: the theme has to be set
      // before React paints anything, so it is applied at the document root rather
      // than inside the component that would be too late to prevent a flash.
      //
      // 1. The default, independent of the OS preference.
      await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');

      // Settings live behind one control now, not stacked in the sidebar body.
      await openSettings(window, 'Appearance');

      // Light is marked as chosen, so the control reports the real state rather
      // than merely looking like a default.
      await expect(window.locator('.ow-choice', { hasText: 'Light' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      // 2. Choose dark through the visible control.
      await window.locator('.ow-choice', { hasText: 'Dark' }).click();
      await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');

      // 3. The choice survives a reload. Without this the whole feature is a
      // no-op that happens to look right until the window is closed.
      await window.reload();
      await expect(window.locator('.ow-app')).toBeVisible();
      await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
      // And the control still reports it, which only holds if the preference was
      // stored rather than the DOM merely left alone.
      await window.locator('.ow-settings-open').click();
      await window.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
      await window.getByRole('tab', { name: 'Appearance' }).click();
      await expect(window.locator('.ow-choice', { hasText: 'Dark' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    } finally {
      await shutdown(app, dir);
    }
  });

  test('storage persists on the file:// origin the renderer runs on', async () => {
    const { app, window, dir } = await launch();
    try {
      // Establishes that the origin is the one under suspicion, so a failure
      // names the cause instead of just reporting that something is wrong.
      const origin = await window.evaluate(() => globalThis.location.origin);
      test.info().annotations.push({ type: 'origin', description: origin });
      expect(origin).toBe('file://');

      const written = await window.evaluate(() => {
        globalThis.localStorage.setItem('openfield.e2e', 'kept');
        return globalThis.localStorage.getItem('openfield.e2e');
      });
      expect(written).toBe('kept');

      await window.reload();
      await expect(window.locator('.ow-app')).toBeVisible();
      const survived = await window.evaluate(() => globalThis.localStorage.getItem('openfield.e2e'));
      expect(survived).toBe('kept');
    } finally {
      await shutdown(app, dir);
    }
  });

  test('ignores a corrupt stored preference rather than failing to open', async () => {
    const { app, window, dir } = await launch();
    try {
      // Garbage that a previous build, a partial write or a curious user could
      // leave behind. The window must still open, and on a sane theme.
      await window.evaluate(() =>
        globalThis.localStorage.setItem('openfield.preferences', '{"theme":"solarized"'),
      );
      await window.reload();
      await expect(window.locator('.ow-app')).toBeVisible();
      await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
    } finally {
      await shutdown(app, dir);
    }
  });
});