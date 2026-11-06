/**
 * Tab indents a whole selection.
 *
 * The wiring is the point. The command is covered at the command level, where
 * the tree shape is deterministic to assert; what can break here is that Tab
 * never reaches the command, which looks exactly like a working feature.
 *
 * A new page already carries one empty block, so three inserts make four. That
 * is not incidental: guessing three made every index below point at the wrong
 * block and the test failed for a reason that had nothing to do with indenting.
 */

import { _electron as electron, type Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const electronMain = join(process.cwd(), 'apps', 'desktop', 'dist', 'main', 'index.js');

async function seeded(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const ow = (
      globalThis as unknown as {
        ow: { execute: (id: string, args?: unknown) => Promise<{ ok: boolean; value: unknown }> };
      }
    ).ow;
    const page = await ow.execute('page.create', { title: 'Indent' });
    await ow.execute('page.open', { id: (page.value as { id: string }).id });
    for (const text of ['first', 'second', 'third']) {
      await ow.execute('block.insert', { type: 'paragraph', text });
    }
  });
  await expect(window.locator('.ow-block')).toHaveCount(4);
}

/** Indentation as the renderer draws it: each block's left margin. */
function margins(window: Page): Promise<string[]> {
  return window.$$eval('.ow-block', (els) => els.map((e) => (e as HTMLElement).style.marginLeft));
}

/** Select blocks 2 and 3 by the gutter, skipping the seeded empty block. */
async function selectSecondAndThird(window: Page, blocks: ReturnType<Page['locator']>): Promise<void> {
  await blocks.nth(2).locator('.ow-block-gutter').click();
  await blocks.nth(3).locator('.ow-block-gutter').click({ modifiers: ['Shift'] });
  await expect(window.locator('.ow-block[data-selected="true"]')).toHaveCount(2);
}

test('Tab indents every selected block, Shift+Tab brings them back', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-indent-'));
  const app = await electron.launch({ args: [electronMain, '--user-data-dir', dir] });
  const window = await app.firstWindow();
  await window.bringToFront();
  try {
    await expect(window.locator('.ow-app')).toBeVisible();
    await seeded(window);

    const blocks = window.locator('.ow-block');
    const before = await margins(window);
    expect(before.length).toBe(4);

    await selectSecondAndThird(window, blocks);

    // Focus inside a selected block so the keystroke reaches the editor. The
    // block selection survives this click, which is what makes the range path
    // reachable at all.
    await blocks.nth(2).locator('.ow-block-text').click({ modifiers: ['Shift'] });
    await window.keyboard.press('Tab');

    const after = await margins(window);
    expect(after[2]).not.toBe(before[2]);
    expect(after[3]).not.toBe(before[3]);
    // Both land at the same depth, one step in. They are siblings being indented
    // under the block above them, not one nested inside the other -- so "equal
    // margins" is the assertion, not "the second is deeper". Expecting 52px here
    // was my error: that would mean block 3 became a child of block 2.
    expect(after[2]).toBe(after[3]);
    expect(after[2]).not.toBe('0px');

    await selectSecondAndThird(window, blocks);
    await blocks.nth(2).locator('.ow-block-text').click({ modifiers: ['Shift'] });
    await window.keyboard.press('Shift+Tab');

    const restored = await margins(window);
    expect(restored[2]).toBe(before[2]);
    expect(restored[3]).toBe(before[3]);
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});