/**
 * Sidebar accessibility.
 *
 * Two things that are easy to claim and hard to prove. The tree roles are only
 * worth anything if the level is right, and "every control is reachable by
 * keyboard" is only true if the things that look like controls are real controls
 * rather than divs with click handlers.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

test('the page list exposes tree semantics with correct depth', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ value: { id: string } }> };
        }
      ).ow;
      const root = await bridge.execute('page.create', { title: 'Root' });
      await bridge.execute('page.create', { title: 'Child', parentPage: root.value.id });
      await bridge.execute('page.create', { title: 'Grandchild', parentPage: (await bridge.execute('page.create', { title: 'Mid', parentPage: root.value.id })).value.id });
    });

    const tree = window.locator('[role="tree"]');
    await expect(tree).toBeVisible();

    // aria-level is what a screen reader uses to say "level 3". A treeitem
    // without it announces as a flat list however deeply it is indented on
    // screen.
    const levels = await window.$$eval('.ow-sidebar [role="treeitem"]', (els) =>
      els.map((e) => e.getAttribute('aria-level')),
    );
    expect(levels).toContain('1');
    expect(levels).toContain('2');
    expect(levels).toContain('3');
  } finally {
    await cleanup();
  }
});

test('the open page is marked selected in the tree', async () => {
  const { window, cleanup } = await launchApp();
  try {
    // Open a page first: a fresh workspace has nothing open, so nothing can be
    // selected, and the assertion would pass or fail for the wrong reason.
    await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as { ow: { execute: (id: string, a?: unknown) => Promise<{ value: { id: string } }> } }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Openable' });
      await bridge.execute('page.open', { id: page.value.id });
    });

    const selected = window.locator('.ow-sidebar [role="treeitem"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    await expect(selected).toContainText('Openable');
  } finally {
    await cleanup();
  }
});

test('every control in the sidebar is a real button or a labelled separator', async () => {
  const { window, cleanup } = await launchApp();
  try {
    // Anything that looks clickable but is not a <button> is unreachable by
    // keyboard, which is the failure this is looking for.
    const notFocusable = await window.$$eval('.ow-sidebar [class*="row"], .ow-sidebar [class*="nav-item"]', (els) =>
      els
        .filter((e) => e.getAttribute('role') !== 'separator')
        .filter((e) => e.tagName !== 'BUTTON' && !e.querySelector('button'))
        .map((e) => `${e.tagName}.${e.className}`),
    );
    expect(notFocusable).toEqual([]);

    // And each one carries a name, so it is announced as something rather than
    // as "button".
    const unnamed = await window.$$eval('.ow-sidebar button', (els) =>
      els
        .filter((e) => {
          const label = e.getAttribute('aria-label') ?? e.textContent ?? '';
          return label.trim().length === 0;
        })
        .map((e) => `${e.tagName}.${e.className}`),
    );
    expect(unnamed).toEqual([]);
  } finally {
    await cleanup();
  }
});