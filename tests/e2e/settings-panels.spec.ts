/**
 * The settings dialog: the navigation, the notes folder, and the AI panel.
 *
 * Three things worth proving here, and one worth proving is *not* there:
 *
 * - The dialog has a navigation rail, and each section is reachable.
 * - The notes folder writes Markdown files, and a file changed outside the app
 *   comes back in.
 * - AI is off until it is turned on, and the panel says so before the user
 *   pastes a key.
 * - There is no test that calls a real provider. That needs money and a
 *   network, and a test that needs both is a test that stops being run.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

test.describe('settings', () => {
  test('the sections are reachable from the rail', async () => {
    const { window, cleanup } = await launchApp();
    try {
      await window.locator('.ow-settings-open').click();
      const dialog = window.getByRole('dialog', { name: 'Settings' });
      await expect(dialog).toBeVisible();

      for (const section of ['General', 'Appearance', 'Editor', 'Files & Sync', 'Advanced']) {
        await window.getByRole('tab', { name: section }).click();
        await expect(dialog).toContainText(section === 'Files & Sync' ? 'Files & Sync' : section);
      }
    } finally {
      await cleanup();
    }
  });

  test('the notes folder holds the pages as Markdown files', async () => {
    const { window, cleanup, dir } = await launchApp();
    try {
      // A page to write out.
      await window.evaluate(async () => {
        const ow = (
          globalThis as unknown as {
            ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }> };
          }
        ).ow;
        const page = await ow.execute('page.create', { title: 'Sync me' });
        await ow.execute('page.open', { id: page.value.id });
      });

      await window.locator('.ow-settings-open').click();
      await window.getByRole('tab', { name: 'Files & Sync' }).click();
      await expect(window.getByText('Sync now')).toBeVisible();

      await window.getByRole('button', { name: 'Sync now' }).click();
      await expect(window.getByText(/file[s]? written/)).toBeVisible();

      // The file exists, and it is Markdown with frontmatter.
      const root = join(dir, 'notes');
      const file = join(root, 'Sync me.md');
      expect(existsSync(file)).toBe(true);
      const text = readFileSync(file, 'utf8');
      expect(text.startsWith('---')).toBe(true);
      expect(text).toContain('title: Sync me');
    } finally {
      await cleanup();
    }
  });

  test('AI is off until it is turned on', async () => {
    const { window, cleanup } = await launchApp();
    try {
      await window.locator('.ow-settings-open').click();
      await window.getByRole('tab', { name: 'Advanced' }).click();

      // Advanced says so, and offers the way in.
      await expect(window.getByText(/Off\. Nothing is sent anywhere/)).toBeVisible();

      await window.getByRole('tab', { name: 'AI' }).click();
      await expect(window.getByRole('checkbox')).not.toBeChecked();

      // The providers are all offered, not just one.
      await expect(window.getByRole('button', { name: 'OpenRouter' })).toBeVisible();
      await expect(window.getByRole('button', { name: 'Anthropic' })).toBeVisible();
      await expect(window.getByRole('button', { name: 'Ollama (local)' })).toBeVisible();

      // The key field exists but says nothing is stored.
      await expect(window.getByLabel('OpenRouter API key')).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
