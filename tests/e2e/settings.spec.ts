/**
 * Appearance settings: they apply, and they survive a reload.
 *
 * The reload is the half that matters. A preference that applies but does not
 * persist is worse than one that does nothing, because it looks like it worked.
 * So the test restarts the window and re-reads rather than checking the DOM
 * immediately after the click.
 *
 * The renderer writes to localStorage and there is no preload bridge for
 * preferences, so this asserts against the same key the app reads.
 */

import { _electron as electron } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const electronMain = join(process.cwd(), 'apps', 'desktop', 'dist', 'main', 'index.js');
const KEY = 'openfield.preferences';

/**
 * Launch against a private profile directory.
 *
 * Preferences live in localStorage on the file:// origin, which is per-profile.
 * `OW_USER_DATA` gives this launch its own profile, so a zoom of 110 left by an
 * earlier run cannot turn one click into 120 -- and so does not have to be
 * scrubbed by hand after the fact.
 *
 * `--user-data-dir` is not honoured by this build; `appearance.spec` passes it
 * and gets the shared profile anyway.
 *
 * The profile path is returned so a *restart* can reuse it. Restarting into a
 * different profile throws the preference away, and the "survives a restart"
 * half of the test then fails for a reason that has nothing to do with the
 * persistence it is meant to be checking.
 */
async function launchIsolated(profile?: string) {
  const dir = profile ?? mkdtempSync(join(tmpdir(), 'ow-settings-profile-'));
  const app = await electron.launch({ args: [electronMain], env: { ...process.env, OW_USER_DATA: dir } });
  const window = await app.firstWindow();
  await window.bringToFront();
  await window.waitForSelector('.ow-app');
  return { app, window, profile: dir };
}

test('appearance settings apply and survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-settings-'));
  let { app, window, profile } = await launchIsolated();

  try {
    await expect(window.locator('.ow-app')).toBeVisible();
    // Settings live behind one control now, not stacked in the sidebar body.
    await window.locator('.ow-settings-open').click();
    await window.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });

    // The dialog has a navigation rail, so the appearance controls are a
    // section rather than the first thing you see.
    await window.getByRole('tab', { name: 'Appearance' }).click();

    // Text size, content width, accent and zoom, each through the real control.
    await window.locator('[aria-label="Text size"]').getByRole('button', { name: 'L' }).click();
    await window.locator('[aria-label="Content width"]').getByRole('button', { name: 'W' }).click();
    await window.locator('[aria-label="Accent colour"]').getByRole('button', { name: 'Teal' }).click();
    await window.locator('[aria-label="Zoom in"]').click();

    // The accent has to reach the document, not just the stored value, or the
    // picker would look like it changed something it did not.
    await expect
      .poll(async () => window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ow-accent').trim()))
      .toBe('#0d9488');

    const before = await window.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}'), KEY);
    expect(before.textSize).toBe('large');
    expect(before.contentWidth).toBe('wide');
    expect(before.zoom).toBe(110);

    await app.close();
    // Relaunched into the SAME profile and WITHOUT clearing: clearing is the
    // point of the second half, so wiping the store here would assert nothing.
    // A different profile would throw the preference away just as effectively.
    ({ app, window } = await launchIsolated(profile));
    await expect(window.locator('.ow-app')).toBeVisible();
    // The controls live behind one dialog now, so they have to be opened before
    // their pressed state can be read at all.
    await window.locator('.ow-settings-open').click();
    await window.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'visible' });
    await window.getByRole('tab', { name: 'Appearance' }).click();

    // The pressed buttons are the observable proof, and they only reflect the
    // restored preference rather than the click that set it.
    await expect(window.locator('[aria-label="Text size"]').getByRole('button', { name: 'L' })).toHaveAttribute('aria-pressed', 'true');
    await expect(window.locator('[aria-label="Content width"]').getByRole('button', { name: 'W' })).toHaveAttribute('aria-pressed', 'true');
    await expect(window.locator('[aria-label="Accent colour"]').getByRole('button', { name: 'Teal' })).toHaveAttribute('aria-pressed', 'true');
    await expect(window.locator('.ow-zoom-value')).toHaveText('110%');
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});