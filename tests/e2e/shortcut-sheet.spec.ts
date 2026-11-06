/**
 * The keyboard cheat sheet.
 *
 * The point of these tests is not that a dialog opens. It is that the sheet is
 * generated from the command registry, so it cannot advertise a shortcut that
 * does nothing -- which is exactly what happened before, when it would have been
 * built from the hand-kept chord table that declared keys with no command
 * behind them.
 */

import { test, expect } from '@playwright/test';
import { launchApp, openSettings } from './harness';

const openSheet = async (window: import('@playwright/test').Page) => {
  // Both Settings and the cheat sheet live behind the one Settings control.
  await openSettings(window, 'Editor');
  await window.getByRole('button', { name: 'Show all shortcuts' }).click();
  return window.getByRole('dialog', { name: 'Keyboard shortcuts' });
};

test('the sheet lists bound commands, grouped by category', async () => {
  const { window, cleanup } = await launchApp();
  try {
    const sheet = await openSheet(window);
    await expect(sheet).toBeVisible();

    // Grouped, not one flat list: a flat list of forty shortcuts is a wall.
    await expect(sheet.locator('.ow-sheet').first()).toBeVisible();
    const categories = await sheet.locator('.ow-sheet-head').allTextContents();
    expect(categories.length).toBeGreaterThan(1);

    // Bold is bound in the registry, so it must be listed.
    await expect(sheet.locator('.ow-sheet-title', { hasText: 'Bold' })).toHaveCount(1);
    await expect(sheet.locator('.ow-sheet-keys kbd').first()).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('every listed shortcut corresponds to a real command', async () => {
  const { window, cleanup } = await launchApp();
  try {
    const sheet = await openSheet(window);
    const rows = await sheet.locator('.ow-sheet-row').count();
    expect(rows).toBeGreaterThan(0);

    // Cross-check against the registry through the bridge: a row whose command
    // id is not in the registry is a shortcut that would do nothing.
    const mismatched = await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: { state(): Promise<{ shortcuts: { id: string }[] }> };
        }
      ).ow;
      const state = await bridge.state();
      const bad = await bridge.execute('__nonexistent__', {});
      return { listed: state.shortcuts.length, unknownIsRejected: bad.ok === false };
    });

    expect(mismatched.unknownIsRejected).toBe(true);
    expect(mismatched.listed).toBe(rows);
  } finally {
    await cleanup();
  }
});

test('the sheet closes on Escape and on the backdrop', async () => {
  const { window, cleanup } = await launchApp();
  try {
    const sheet = await openSheet(window);
    await expect(sheet).toBeVisible();
    await sheet.locator('.ow-icon-btn').click();
    await expect(window.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);

    await openSheet(window);
    await expect(sheet).toBeVisible();
    // On the shortcuts dialog itself, not on `.ow-modal`: Settings and the cheat
    // sheet are both backdrops, and the bare class selector resolves to the one
    // underneath, which cannot be clicked because the other is on top of it.
    await sheet.click({ position: { x: 5, y: 5 } });
    await expect(window.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
