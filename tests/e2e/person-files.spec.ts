/**
 * The person and files cells, drawn.
 *
 * The unit tests cover the storage. This covers the part a user touches: that a
 * person property shows a *name* rather than an id, and that a files property
 * shows a file rather than nothing.
 *
 * A row of hashes is what you get when the storage works and the renderer does
 * not, and it is invisible in the model.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

test('a person property draws the name, and a files property draws the file', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: {
            execute: (
              id: string,
              a?: unknown,
            ) => Promise<{ ok: boolean; value: { id?: string; collectionId?: string; person?: { id: string } } }>;
          };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'People' });
      const db = await bridge.execute('db.create', { name: 'Tasks', pageId: page.value.id });
      const collectionId = db.value.id!;
      const row = await bridge.execute('db.row.add', { collectionId, title: 'A row' });

      const person = await bridge.execute('db.people.add', { name: 'Sam Rivera' });

      const owner = await bridge.execute('db.property.add', { collectionId, name: 'Owner', type: 'person' });
      const files = await bridge.execute('db.property.add', { collectionId, name: 'Attachments', type: 'files' });
      const ownerId = (owner.value as { properties: { name: string; id: string }[] }).properties.find(
        (p) => p.name === 'Owner',
      )!.id;
      const filesId = (files.value as { properties: { name: string; id: string }[] }).properties.find(
        (p) => p.name === 'Attachments',
      )!.id;

      await bridge.execute('db.value.set', {
        collectionId,
        pageId: row.value.id,
        propertyId: ownerId,
        value: [person.value.person!.id],
      });
      await bridge.execute('db.value.set', {
        collectionId,
        pageId: row.value.id,
        propertyId: filesId,
        value: [{ sha256: 'abc123', name: 'notes.pdf', mime: 'application/pdf', size: 2048 }],
      });

      // Open the page last. A collection attached to a page is only rendered
      // when that page is the one on screen.
      await bridge.execute('page.open', { id: page.value.id });
    });

    // The page is still the one with the table on it.
    await window.locator('.ow-db-table').waitFor({ state: 'visible' });

    // What the renderer actually has. If the directory did not reach it, the
    // cell falls back to showing the id -- and the symptom is a row of hashes
    // that looks like a rendering bug rather than a state one.
    const dir = await window.evaluate(async () => {
      const bridge = (globalThis as unknown as { ow: { state(): Promise<{ people: unknown[] }> } }).ow;
      return (await bridge.state()).people;
    });
    expect(dir, 'the people directory never reached the renderer').not.toHaveLength(0);

    // The name, not the id.
    await expect(window.locator('.ow-db-person')).toHaveText('Sam Rivera');

    // The file, with its name visible.
    await expect(window.locator('.ow-db-file')).toContainText('notes.pdf');
  } finally {
    await cleanup();
  }
});
