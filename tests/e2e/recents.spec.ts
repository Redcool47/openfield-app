/**
 * Recents.
 *
 * The storage half (`noteOpened`, `recentPages`) and the sidebar section were
 * already there and already wired -- `session.openPage` calls `noteOpened`, and
 * `repo.recentPages(1)` picks what to resume on. What was missing was the list
 * a person would actually use, and the one behaviour that made the stored data
 * wrong: trashing a page left its row in `recent`, so the list offered a
 * destination that opened onto an empty page in the bin.
 */

import { test, expect } from '@playwright/test';
import { launchApp, seedPage } from './harness';

test('the Recents section lists pages in the order they were opened', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'Recents', [{ type: 'paragraph', text: 'first page' }]);
    const second = await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ value: { id: string } }> };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Second page' });
      await bridge.execute('page.open', { id: page.value.id });
      return page.value.id;
    });

    await window.locator('.ow-section-head', { hasText: 'Recents' }).click();
    const section = window.locator('.ow-section', { hasText: 'Recents' });
    await expect(section.locator('.ow-row')).toHaveCount(2);

    // Newest first. The order is the whole value of a recents list; an
    // alphabetical one is just a second copy of the page tree.
    const titles = await section.locator('.ow-row-title, .ow-row-main').allTextContents();
    expect(titles.join(' ')).toContain('Second page');
    expect(titles[0]).toContain('Second page');
    expect(second).toBeTruthy();
  } finally {
    await cleanup();
  }
});

test('opening a page twice does not duplicate it', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'Once', [{ type: 'paragraph', text: 'body' }]);
    const id = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { ow: { state(): Promise<{ current: { id: string } }> } }).ow;
      return (await bridge.state()).current.id;
    });

    // Twice, with a gap: opened_at is millisecond resolution, so without a real
    // gap the two upserts land on the same timestamp and the ordering assertion
    // below would pass for the wrong reason.
    await window.evaluate(async (pageId) => {
      const bridge = (globalThis as unknown as { ow: { execute: (id: string, a?: unknown) => Promise<unknown> } }).ow;
      await bridge.execute('page.open', { id: pageId });
      await new Promise((r) => setTimeout(r, 50));
      await bridge.execute('page.open', { id: pageId });
    }, id);

    await window.locator('.ow-section-head', { hasText: 'Recents' }).click();
    const section = window.locator('.ow-section', { hasText: 'Recents' });
    // page_id is the primary key, so a repeat open updates rather than inserts.
    await expect(section.locator('.ow-row')).toHaveCount(1);
  } finally {
    await cleanup();
  }
});

test('a trashed page leaves Recents', async () => {
  const { window, cleanup } = await launchApp();
  try {
    const id = await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ value: { id: string } }> };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Doomed' });
      await bridge.execute('page.open', { id: page.value.id });
      return page.value.id;
    });

    await window.locator('.ow-section-head', { hasText: 'Recents' }).click();
    const recents = window.locator('.ow-section', { hasText: 'Recents' });
    await expect(recents.locator('.ow-row')).toHaveCount(1);

    await window.evaluate(async (pageId) => {
      const bridge = (globalThis as unknown as { ow: { execute: (id: string, a?: unknown) => Promise<unknown> } }).ow;
      await bridge.execute('page.moveToTrash', { id: pageId });
    }, id);

    // The row is still in the recent table but resolves to a trashed page.
    // The query already filters those out; without that this list would offer a
    // destination that opens onto an empty page, which reads as a broken link.
    await expect(window.locator('.ow-section', { hasText: 'Recents' }).locator('.ow-row')).toHaveCount(0);
    await expect(window.locator('.ow-empty-hint', { hasText: 'Nothing opened yet' })).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('an empty Recents section says so rather than showing nothing', async () => {
  const { window, cleanup } = await launchApp();
  try {
    // A fresh workspace has opened nothing. An empty section with no explanation
    // reads as a broken sidebar.
    await window.locator('.ow-section-head', { hasText: 'Recents' }).click();
    await expect(window.locator('.ow-section', { hasText: 'Recents' })).toContainText('Nothing opened yet');
  } finally {
    await cleanup();
  }
});
