/**
 * List and gallery views.
 *
 * Both are reached through a view of that type, so the test has to create the
 * view first. Without that the switch would never run and the components would
 * be dead code that typechecks -- which is exactly how a view nobody can open
 * survives a release.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/** Create a database with two rows and add a view of the given type. */
async function databaseWithView(
  window: import('@playwright/test').Page,
  viewType: string,
): Promise<void> {
  await window.evaluate(async (type) => {
    const bridge = (
      globalThis as unknown as {
        ow: {
          execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string; collectionId?: string } }>;
        };
      }
    ).ow;
    // The page is made first so the collection lands on it. Letting db.create make
    // its own page leaves two pages, only one of which has the rows.
    const page = await bridge.execute('page.create', { title: 'Views' });
    const db = await bridge.execute('db.create', { name: 'Views', pageId: page.value.id });
    const collectionId = db.value.collectionId ?? db.value.id;

    await bridge.execute('db.row.add', { collectionId, title: 'Alpha' });
    await bridge.execute('db.row.add', { collectionId, title: 'Beta' });
    await bridge.execute('db.view.add', { collectionId, type, name: type });
    await bridge.execute('page.open', { id: page.value.id });
  }, viewType);
}

test('a list view renders one line per row', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await databaseWithView(window, 'list');
    await window.locator('.ow-db-views button', { hasText: 'list' }).click();
    await expect(window.locator('.ow-list')).toBeVisible();
    await expect(window.locator('.ow-list-row')).toHaveCount(2);
    await expect(window.locator('.ow-list-row').first()).toContainText('Alpha');
  } finally {
    await cleanup();
  }
});

test('a gallery view renders a card per row', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await databaseWithView(window, 'gallery');
    await window.locator('.ow-db-views button', { hasText: 'gallery' }).click();
    await expect(window.locator('.ow-gallery')).toBeVisible();
    await expect(window.locator('.ow-card')).toHaveCount(2);
    await expect(window.locator('.ow-card').first()).toContainText('Alpha');
  } finally {
    await cleanup();
  }
});

test('a row added from the table appears in the table', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await databaseWithView(window, 'table');
    await expect(window.locator('.ow-db-title-input')).toHaveCount(2);

    await window.locator('.ow-db-add-btn').click();

    // The rows the table draws are its own state, not the parent's, so a new row
    // reaches the database but not the table unless the table asks again. This
    // is the difference between "the button did nothing" and "a page was made".
    await expect(window.locator('.ow-db-title-input')).toHaveCount(3);
    await expect(window.locator('.ow-db-title-input').last()).toHaveValue('');

    // And it is a real row: naming it stores the name on the page. The name has
    // a space in it, because a space used to bubble to the cell's key handler
    // and open the row's own page mid-word.
    const last = window.locator('.ow-db-title-input').last();
    await last.click();
    await window.keyboard.type('Gamma Delta');
    await window.keyboard.press('Tab');
    await expect(last).toHaveValue('Gamma Delta');
    await expect(window.locator('.ow-db-title-input')).toHaveCount(3);

    // The row is a page of its own, so naming it must not rename the page the
    // table sits on. Before, `page.rename` used the open page whatever id the
    // caller passed, and the breadcrumb above the table took the row's name.
    const titles = await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: {
            state(): Promise<{ current: { title: string }; pages: { title: string }[] }>;
          };
        }
      ).ow;
      const state = await bridge.state();
      return { open: state.current.title, pages: state.pages.map((p) => p.title) };
    });
    expect(titles.open).toBe('Views');
    expect(titles.pages).toContain('Gamma Delta');
  } finally {
    await cleanup();
  }
});