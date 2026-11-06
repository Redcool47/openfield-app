/**
 * The AI bubble and the debug mode.
 *
 * The bubble is the one piece of this application that is allowed to be
 * always there, and only under two conditions: the user has turned AI on and
 * pasted in a key of their own, or the debug mode is on and they want to look
 * at it.
 *
 * So the test turns the debug mode on and checks the bubble appears even
 * though AI is off, and that it says so plainly rather than pretending to be
 * broken.
 */

import { test, expect } from '@playwright/test';
import { launchApp, openSettings } from './harness';

test.describe('the AI bubble', () => {
  test('is hidden when AI is off and the debug mode is off', async () => {
    const { window, cleanup } = await launchApp();
    try {
      await expect(window.locator('.ow-ai-bubble')).toHaveCount(0);
    } finally {
      await cleanup();
    }
  });

  test('the debug mode shows it even when AI is off, and it says so', async () => {
    const { window, cleanup } = await launchApp();
    try {
      await openSettings(window, 'Advanced');
      await window.getByRole('checkbox').check();

      // The settings overlay covers the window, so the dialog has to be closed
      // before the bubble can be reached.
      await window.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close settings' }).click();

      const bubble = window.locator('.ow-ai-bubble');
      await expect(bubble).toBeVisible();

      // Opening it says AI is off, rather than looking like a button that
      // does nothing.
      await bubble.click();
      await expect(window.getByRole('dialog', { name: 'Ask the AI' })).toBeVisible();
      await expect(window.getByText(/AI is off/)).toBeVisible();

      // And the way out is the settings, not a dead end.
      await window.getByRole('button', { name: 'Open the AI settings' }).click();
      await expect(window.getByRole('tab', { name: 'AI' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      await cleanup();
    }
  });

  test('the panel shows the diagnostics when the debug mode is on', async () => {
    const { window, cleanup } = await launchApp();
    try {
      await openSettings(window, 'Advanced');
      await window.getByRole('checkbox').check();
      await window.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close settings' }).click();

      await window.locator('.ow-ai-bubble').click();
      await expect(window.locator('.ow-ai-debug')).toBeVisible();
      await expect(window.locator('.ow-ai-debug')).toContainText('blocks');
    } finally {
      await cleanup();
    }
  });
});
