/**
 * The table-of-contents block, and moving a page to a new parent.
 *
 * The TOC test exists because `toc` was in the block registry from the first
 * release and rendered as an ordinary paragraph: it could be inserted from the
 * slash menu and did nothing. A block type existing in the registry is not the
 * same as the block type existing.
 */

import { test, expect } from '@playwright/test';
import { launchApp, seedPage } from './harness';

test('a toc block lists the page headings at their levels', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: {
            execute: (
              id: string,
              a?: unknown,
            ) => Promise<{ ok: boolean; value: { id: string } }>;
          };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Outline' });
      await bridge.execute('page.open', { id: page.value.id });
      await bridge.execute('block.insert', { type: 'heading1', text: 'Alpha' });
      await bridge.execute('block.insert', { type: 'heading2', text: 'Beta' });
      await bridge.execute('block.insert', { type: 'heading3', text: 'Gamma' });
      await bridge.execute('block.insert', { type: 'paragraph', text: 'not a heading' });
      await bridge.execute('block.insert', { type: 'tableOfContents', text: '' });
    });

    const toc = window.locator('.ow-toc');
    await expect(toc).toBeVisible();
    const entries = toc.locator('.ow-toc-entry');
    await expect(entries).toHaveCount(3);
    await expect(entries.nth(0)).toHaveText('Alpha');
    await expect(entries.nth(1)).toHaveText('Beta');
    await expect(entries.nth(2)).toHaveText('Gamma');

    // Levels drive the indent, so a level 2 entry is indented past a level 1.
    await expect(entries.nth(0)).toHaveAttribute('data-level', '1');
    await expect(entries.nth(2)).toHaveAttribute('data-level', '3');
    const pad = await entries.nth(2).evaluate((el) => parseInt(getComputedStyle(el).paddingLeft, 10));
    const padFirst = await entries.nth(0).evaluate((el) => parseInt(getComputedStyle(el).paddingLeft, 10));
    expect(pad).toBeGreaterThan(padFirst);
  } finally {
    await cleanup();
  }
});

test('a toc on a page with no headings says so instead of rendering blank', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: {
            execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }>;
          };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Empty' });
      await bridge.execute('page.open', { id: page.value.id });
      await bridge.execute('block.insert', { type: 'tableOfContents', text: '' });
    });
    await expect(window.locator('.ow-toc--empty')).toContainText('No headings yet');
  } finally {
    await cleanup();
  }
});

test('a toc entry scrolls to its heading', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: {
            execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }>;
          };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Scroll' });
      await bridge.execute('page.open', { id: page.value.id });
      for (let i = 0; i < 30; i++) {
        await bridge.execute('block.insert', { type: 'paragraph', text: `filler ${i}` });
      }
      await bridge.execute('block.insert', { type: 'heading1', text: 'The Target' });
      await bridge.execute('block.insert', { type: 'tableOfContents', text: '' });
    });

    await expect(window.locator('.ow-toc-entry')).toHaveCount(1);
    const before = await window.evaluate(() => document.querySelector('.ow-page-scroll')!.scrollTop);
    await window.locator('.ow-toc-entry').click();
    await window.waitForTimeout(700); // smooth scroll
    const after = await window.evaluate(() => document.querySelector('.ow-page-scroll')!.scrollTop);
    expect(after).toBeGreaterThan(before);
  } finally {
    await cleanup();
  }
});

test('a page can be moved under a different parent', async () => {
  const { window, cleanup } = await launchApp();
  try {
    const result = await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: {
            execute: (
              id: string,
              a?: unknown,
            ) => Promise<{ ok: boolean; error?: string; value?: { id: string } }>;
          };
        }
      ).ow;
      const home = await bridge.execute('page.create', { title: 'Home' });
      const target = await bridge.execute('page.create', { title: 'Target' });
      const child = await bridge.execute('page.create', { title: 'Child' });

      const move = await bridge.execute('page.move', {
        id: child.value.id,
        parentPage: target.value.id,
      });

      const state = await bridge.state();
      const found = state.pages.find((p: { id: string }) => p.id === child.value.id);
      return { move, parent: found?.parentPage ?? null, target: target.value.id };
    });

    expect(result.move.ok, result.move.error).toBe(true);
    expect(result.parent).toBe(result.target);
  } finally {
    await cleanup();
  }
});

test('a page cannot be moved inside itself', async () => {
  const { window, cleanup } = await launchApp();
  try {
    const bad = await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: {
            execute: (id: string, a?: unknown) => Promise<{ ok: boolean; error?: string; value?: { id: string } }>;
          };
        }
      ).ow;
      const root = await bridge.execute('page.create', { title: 'Root' });
      const child = await bridge.execute('page.create', { title: 'Child', parentPage: root.value.id });
      // Dropping a parent inside its own child would detach the subtree.
      return bridge.execute('page.move', { id: root.value.id, parentPage: child.value.id });
    });
    expect(bad.ok).toBe(false);
  } finally {
    await cleanup();
  }
});
