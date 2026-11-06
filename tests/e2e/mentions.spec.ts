/**
 * Page mentions via `@`.
 *
 * Two things are easy to get wrong and both are asserted here:
 *
 *   - The trigger. An `@` in the middle of a word is an email address or a
 *     handle, and opening a page picker over it makes those untypeable.
 *   - The stored form. The mention replaces the query text with the page's
 *     title as real characters carrying an inline node. If it stored the literal
 *     "@proj", then search, export and word count would all disagree with what
 *     is on screen -- so the test reads the runs, not the rendering.
 */

import { test, expect } from '@playwright/test';
import { launchApp, seedPage } from './harness';

/** A page with a linkable target and an empty block to type into. */
async function withTarget() {
  const app = await launchApp();
  const ids = await app.window.evaluate(async () => {
    const bridge = (
      globalThis as unknown as {
        ow: {
          execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }>;
        };
      }
    ).ow;
    const page = await bridge.execute('page.create', { title: 'Notebook' });
    await bridge.execute('page.open', { id: page.value.id });
    await bridge.execute('block.insert', { type: 'paragraph', text: '' });
    const target = await bridge.execute('page.create', { title: 'Quarterly Plan' });
    return { pageId: page.value.id, targetId: target.value.id };
  });
  return { app, ids };
}

const typeMention = async (window: import('@playwright/test').Page, query: string) => {
  const block = window.locator('.ow-block-text').first();
  await block.click();
  await block.press('@');
  if (query) {
    for (const ch of query) await block.press(ch);
  }
  return window.locator('.ow-mention');
};

test('typing @ at the start of a line opens a page picker', async () => {
  const { app } = await withTarget();
  try {
    const menu = await typeMention(app.window, 'Quarter');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('role', 'listbox');
    await expect(menu.locator('.ow-slash-label')).toHaveText('Quarterly Plan');
  } finally {
    await app.cleanup();
  }
});

test('an @ inside a word does not open the picker', async () => {
  const { app } = await withTarget();
  try {
    const block = app.window.locator('.ow-block-text').first();
    await block.click();
    await block.press('a');
    await block.press('b');
    await block.press('@');
    // "ab@" is a handle, not a mention. A picker here makes email addresses
    // untypeable in a document editor.
    await expect(app.window.locator('.ow-mention')).toHaveCount(0);
    await expect(block).toContainText('ab@');
  } finally {
    await app.cleanup();
  }
});

test('picking a page stores an inline node holding the title', async () => {
  const { app, ids } = await withTarget();
  try {
    const menu = await typeMention(app.window, 'Quarter');
    await expect(menu).toBeVisible();
    await app.window.keyboard.press('Enter');

    // Read the model, not the screen: the point is what was stored.
    const stored = await app.window.evaluate(async (args) => {
      const bridge = (
        globalThis as unknown as {
          ow: { state(): Promise<{ current: { rows: { runs?: unknown[] }[] } }> };
        }
      ).ow;
      const state = await bridge.state();
      return JSON.stringify(state.current.rows.map((r) => r.runs ?? []));
    }, ids);

    // The literal "@Quarter" is gone: the query was replaced by the title.
    expect(stored).not.toContain('@Quarter');
    expect(stored).toContain('Quarterly Plan');
    expect(stored).toContain('"kind":"page"');
    expect(stored).toContain(ids.targetId);
  } finally {
    await app.cleanup();
  }
});

test('a mention renders as a chip on the same characters', async () => {
  const { app } = await withTarget();
  try {
    const menu = await typeMention(app.window, 'Quarter');
    await expect(menu).toBeVisible();
    await app.window.keyboard.press('Enter');

    // Blur swaps the editing text for the drawn runs.
    await app.window.locator('.ow-page-title').click();
    const chip = app.window.locator('.ow-block-text .ow-inline[data-inline="page"]').first();
    await expect(chip).toBeVisible();
    // The chip carries the same characters the model holds, which is what keeps
    // search and export agreeing with the display.
    await expect(chip).toContainText('Quarterly Plan');
  } finally {
    await app.cleanup();
  }
});

test('backspacing past the @ closes the picker', async () => {
  const { app } = await withTarget();
  try {
    const block = app.window.locator('.ow-block-text').first();
    await block.click();
    await block.press('@');
    await block.press('Q');
    await expect(app.window.locator('.ow-mention')).toBeVisible();
    await block.press('Backspace');
    await block.press('Backspace');
    // Closing is not a separate rule: the query is recomputed from the caret on
    // every input, so removing the @ makes it disappear by itself.
    await expect(app.window.locator('.ow-mention')).toHaveCount(0);
  } finally {
    await app.cleanup();
  }
});
