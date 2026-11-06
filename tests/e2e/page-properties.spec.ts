/**
 * The properties area on a page that is a database row.
 *
 * This could not be built before: a page hosting a collection and a page being
 * a row in one were both answered by the same question, so a row page was
 * indistinguishable from an ordinary document and there was nowhere to hang its
 * properties. `rowOf` is the new answer.
 *
 * The assertion that matters is the edit round trip, on a `number` property
 * because that is one of the types `Cell` actually makes editable -- a `text`
 * property renders a read-only span by design, and testing that as if it were an
 * editor would be testing a label.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/** A database with one row open, using the default schema plus a Due number. */
async function rowWithProperties() {
  const app = await launchApp();
  const ids = await app.window.evaluate(async () => {
    const bridge = (
      globalThis as unknown as {
        ow: {
          execute: (
            id: string,
            a?: unknown,
          ) => Promise<{ ok: boolean; value: { id: string; collectionId?: string; properties?: unknown } }>;
        };
      }
    ).ow;
    const page = await bridge.execute('page.create', { title: 'Tasks' });
    const db = await bridge.execute('db.create', { name: 'Tasks', pageId: page.value.id });
    const collectionId = db.value.collectionId ?? db.value.id;

    // db.create already makes a default schema -- Name, Status, and others --
    // and db.property.add returns the whole schema rather than the one property.
    // Reaching for `add.value.id` gives undefined, which then fails at
    // db.value.set with "no such property" and leaves every cell blank.
    const added = await bridge.execute('db.property.add', {
      collectionId,
      name: 'Due',
      type: 'number',
    });
    const schema = (added.value as { properties: { id: string; name: string }[] }).properties;
    const due = schema.find((p) => p.name === 'Due')!;
    const status = schema.find((p) => p.name === 'Status')!;

    const row = await bridge.execute('db.row.add', { collectionId, title: 'Write the report' });
    // Raw scalars, not {optionId: ...} or {text: ...}: coerceValue takes the
    // bare value and an object stringifies to "[object Object]".
    await bridge.execute('db.value.set', {
      collectionId,
      pageId: row.value.id,
      propertyId: status.id,
      value: 'opt-progress',
    });
    await bridge.execute('db.value.set', {
      collectionId,
      pageId: row.value.id,
      propertyId: due.id,
      value: 3,
    });
    await bridge.execute('page.open', { id: row.value.id });
    return { collectionId, rowId: row.value.id, stageId: status.id, dueId: due.id };
  });
  return { app, ids };
}

/** The properties row labelled `name`. */
const propRow = (app: { window: import('@playwright/test').Page }, name: string) =>
  app.window.locator('.ow-props-row').filter({ hasText: name });

test('a row page shows its properties above the body', async () => {
  const { app } = await rowWithProperties();
  try {
    const props = app.window.locator('.ow-props');
    await expect(props).toBeVisible();
    await expect(propRow(app, 'Status')).toContainText('In progress');
    // On the input, not on the row: toHaveValue reads a form control's value.
    await expect(propRow(app, 'Due').locator('input')).toHaveValue('3');

    // Above the article body, not inside it: properties belong to the row, not
    // to the document, and must not reflow with the page's own font or width.
    const above = await props.evaluate((el) => {
      const article = document.querySelector('.ow-page');
      return el.compareDocumentPosition(article!) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false;
    });
    expect(above).toBe(true);
  } finally {
    await app.cleanup();
  }
});

test('an ordinary page shows no properties area', async () => {
  const app = await launchApp();
  try {
    await app.window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ value: { id: string } }> };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Plain' });
      await bridge.execute('page.open', { id: page.value.id });
    });
    // A row page and an ordinary document used to look identical from here.
    await expect(app.window.locator('.ow-props')).toHaveCount(0);
  } finally {
    await app.cleanup();
  }
});

test('editing in the properties area writes back to the database', async () => {
  const { app, ids } = await rowWithProperties();
  try {
    const input = propRow(app, 'Due').locator('input');
    await input.fill('7');
    // The Cell commits on blur, so blurring is the action, not a detail.
    await input.blur();

    // Read it back from the database, not from the screen: a value that only
    // looks updated is a read-only label wearing an editor's clothes.
    const stored = await app.window.evaluate(async (args) => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ value: unknown }> };
        }
      ).ow;
      const res = await bridge.execute('db.rows', { collectionId: args.collectionId });
      const rows = (res.value as { rows?: { id: string; values: Record<string, unknown> }[] }).rows ?? [];
      const row = rows.find((r) => r.id === args.rowId);
      return row ? row.values[args.dueId as string] : null;
    }, ids);

    expect(JSON.stringify(stored)).toContain('7');
  } finally {
    await app.cleanup();
  }
});

test('the properties area is gone once the row is not a row', async () => {
  const { app, ids } = await rowWithProperties();
  try {
    await expect(app.window.locator('.ow-props')).toBeVisible();
    // Move the row out from under its collection; it is an ordinary page again.
    await app.window.evaluate(async (rowId) => {
      const bridge = (
        globalThis as unknown as { ow: { execute: (id: string, a?: unknown) => Promise<unknown> } }
      ).ow;
      await bridge.execute('page.move', { id: rowId, parentPage: '' });
    }, ids.rowId);
    await expect(app.window.locator('.ow-props')).toHaveCount(0);
  } finally {
    await app.cleanup();
  }
});
