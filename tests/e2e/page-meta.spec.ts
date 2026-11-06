/**
 * The page lock, the last-edited line and the backlinks section, drawn.
 *
 * The unit tests cover the storage and the commands. This covers what the
 * reader sees: a lock that says the page is locked, a line that says when it
 * was last touched, and a list of the pages that mention it.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

test('a locked page says so, and says when it was last edited', async () => {
  const { window, cleanup } = await launchApp();
  try {
    const id = await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }> };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Locked page' });
      await bridge.execute('page.open', { id: page.value.id });
      await bridge.execute('page.lock', { id: page.value.id });
      return page.value.id;
    });

    // The lock is a property of the page, shown where the reader is already
    // looking.
    await expect(window.locator('.ow-page-locked')).toBeVisible();
    await expect(window.locator('.ow-page-locked')).toContainText('Locked');

    // And the page says when it was last touched.
    await expect(window.locator('.ow-page-edited')).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('the pages that mention this one are listed', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }> };
        }
      ).ow;
      const target = await bridge.execute('page.create', { title: 'The Plan' });
      const source = await bridge.execute('page.create', { title: 'Talking about it' });
      await bridge.execute('page.open', { id: source.value.id });
      const block = await bridge.execute('block.insert', { type: 'paragraph', text: 'see ' });
      await bridge.execute('inline.page.set', {
        id: (block.value as { id: string }).id,
        from: 0,
        to: 0,
        pageId: target.value.id,
      });
      await bridge.execute('page.open', { id: target.value.id });
    });

    const backlinks = window.locator('.ow-backlinks');
    await expect(backlinks).toBeVisible();
    await expect(backlinks.locator('.ow-backlinks-item')).toHaveCount(1);
    await expect(backlinks).toContainText('Talking about it');
  } finally {
    await cleanup();
  }
});

test('a page nobody mentions has no backlinks section', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }> };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Alone' });
      await bridge.execute('page.open', { id: page.value.id });
    });
    // An empty section is noise; the reference shows nothing when there is
    // nothing to show.
    await expect(window.locator('.ow-backlinks')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
