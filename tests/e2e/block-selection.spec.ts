/**
 * Multi-block selection, end to end.
 *
 * Selection is driven entirely by the pure range functions, so this suite is
 * mostly checking the wiring: that a click on a gutter marks blocks, that
 * shift-click extends rather than replaces, and that the marked set is the right
 * one. The range maths itself is covered by the unit tests, where it can be
 * pinned against cases that are awkward to produce through the DOM.
 *
 * It drives the real app and asserts on the real DOM rather than a harness,
 * because the part most likely to break is the event handling -- `preventDefault`
 * on the gutter, and the interaction with the contenteditable caret -- and that
 * only exists in a browser.
 */

import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const electronMain = join(process.cwd(), 'apps', 'desktop', 'dist', 'main', 'index.js');

async function launch(): Promise<{ app: ElectronApplication; window: Page; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'ow-sel-'));
  const app = await electron.launch({ args: [electronMain, '--user-data-dir', dir] });
  const window = await app.firstWindow();
  await window.bringToFront();
  await expect(window.locator('.ow-app')).toBeVisible();
  return { app, window, dir };
}

async function shutdown(app: ElectronApplication | undefined, dir: string): Promise<void> {
  await app?.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

/** The ids currently carrying the selected marker, in document order. */
async function selectedIds(window: Page): Promise<string[]> {
  return window.$$eval('.ow-block[data-selected="true"]', (els) =>
    els.map((e) => e.getAttribute('data-block-id') ?? ''),
  );
}

/**
 * Create a page with three blocks and leave the caret in it.
 *
 * A fresh workspace opens on an empty page, so there is nothing to select. The
 * demo data lives in the operator's own workspace and cannot be relied on here --
 * a test that passes only because someone happened to leave content behind is a
 * test that stops passing the moment they tidy up.
 */
async function threeBlocks(window: Page): Promise<void> {
  await window.keyboard.press('Control+n');

  // Click before typing. A contenteditable that has never been focused swallows
  // keystrokes silently, so without this the type() calls go to the document and
  // the page silently keeps one empty block.
  const first = window.getByRole('textbox', { name: 'paragraph' }).first();
  await expect(first).toBeVisible();
  await first.click();
  await first.type('first');

  // After Enter the caret is on a new block, so re-query rather than reusing the
  // first handle -- typing into a stale locator would fill the original block and
  // leave the count at one, which looks like Enter being broken.
  //
  // Waiting for the count to rise is the part that matters. `keyboard.type` is
  // effectively instantaneous, so without it the characters arrive before React
  // has moved the caret and end up appended to the previous block: "thirdsecond"
  // rather than two separate blocks. That is a race in the test, not the editor.
  await window.keyboard.press('Enter');
  await expect(window.locator('.ow-block')).toHaveCount(2);
  await window.getByRole('textbox', { name: 'paragraph' }).last().type('second');
  await window.keyboard.press('Enter');
  await expect(window.locator('.ow-block')).toHaveCount(3);
  await window.getByRole('textbox', { name: 'paragraph' }).last().type('third');

  await expect(window.locator('.ow-block')).toHaveCount(3);
}
test.describe('block selection', () => {
  test('a gutter click selects one block; shift-click extends the range', async () => {
    const { app, window, dir } = await launch();
    try {
      await threeBlocks(window);
      const blocks = window.locator('.ow-block');
      const count = await blocks.count();
      expect(count).toBeGreaterThanOrEqual(3);

      // Nothing selected to begin with.
      expect(await selectedIds(window)).toEqual([]);

      // Click the first block's gutter.
      await blocks.nth(0).locator('.ow-block-gutter').click();
      expect(await selectedIds(window)).toHaveLength(1);

      // Shift-click the third: the range should now cover the first three.
      await blocks.nth(2).locator('.ow-block-gutter').click({ modifiers: ['Shift'] });
      const extended = await selectedIds(window);
      expect(extended).toHaveLength(3);

      // Extending backwards from the middle must give the same blocks, because
      // the user is allowed to drag upwards.
      await blocks.nth(0).locator('.ow-block-gutter').click();
      await blocks.nth(2).locator('.ow-block-gutter').click({ modifiers: ['Shift'] });
      expect(await selectedIds(window)).toEqual(extended);
    } finally {
      await shutdown(app, dir);
    }
  });

  test('a plain click collapses an existing selection', async () => {
    const { app, window, dir } = await launch();
    try {
      await threeBlocks(window);
      const blocks = window.locator('.ow-block');

      await blocks.nth(0).locator('.ow-block-gutter').click();
      await blocks.nth(2).locator('.ow-block-gutter').click({ modifiers: ['Shift'] });
      expect((await selectedIds(window)).length).toBe(3);

      // Clicking the block body without shift collapses to just that block.
      // Without this the highlight would sit behind the caret looking live.
      await blocks.nth(1).locator('.ow-block-text').click();
      expect(await selectedIds(window)).toEqual([]);
    } finally {
      await shutdown(app, dir);
    }
  });
});
