/**
 * Dragging a block, and Escape narrowing a selection.
 *
 * The drag test is about the *command*, not the pointer. HTML5 drag-and-drop
 * through Playwright is reliable enough to drive but not to assert on, and what
 * can go wrong is the tree shape afterwards: a move that lands a parent inside
 * its own child detaches the subtree from the page, and that is invisible until
 * the page is reopened.
 */

import { test, expect, type Page } from '@playwright/test';
import { launchApp, seedPage } from './harness';

interface Row {
  id: string;
  text: string;
}

/** The open page's blocks in document order, without the seeded empty one. */
const readRows = async (window: Page): Promise<Row[]> => {
  const rows = await window.evaluate(async () => {
    const bridge = (
      globalThis as unknown as { ow: { state(): Promise<{ current: { rows: Row[] } }> } }
    ).ow;
    return (await bridge.state()).current.rows.map((r) => ({ id: r.id, text: r.text }));
  });
  // A new page already carries one empty block. Counting it makes every index
  // below point at the wrong block.
  return rows.filter((r) => r.text !== '');
};

const moveTo = (window: Page, id: string, targetId: string, position: 'before' | 'after') =>
  window.evaluate(
    async (args) => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; error?: string }> };
        }
      ).ow;
      return bridge.execute('block.moveTo', args);
    },
    { id, targetId, position },
  );

test('a block can be dragged below another', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'drag', [
      { type: 'paragraph', text: 'alpha' },
      { type: 'paragraph', text: 'beta' },
      { type: 'paragraph', text: 'gamma' },
    ]);

    const rows = await readRows(window);
    const alpha = rows.find((r) => r.text === 'alpha')!;
    const gamma = rows.find((r) => r.text === 'gamma')!;

    const moved = await moveTo(window, alpha.id, gamma.id, 'after');
    expect(moved.ok, moved.error).toBe(true);

    expect((await readRows(window)).map((r) => r.text)).toEqual(['beta', 'gamma', 'alpha']);
  } finally {
    await cleanup();
  }
});

test('a block cannot be dragged into its own subtree', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'cycle', [
      { type: 'paragraph', text: 'parent' },
      { type: 'bulletedListItem', text: 'child' },
    ]);

    const rows = await readRows(window);
    const parent = rows.find((r) => r.text === 'parent')!;
    const child = rows.find((r) => r.text === 'child')!;

    // seedPage inserts siblings, so the child has to be nested explicitly --
    // otherwise this is a legal sibling reorder and asserts nothing.
    const indented = await window.evaluate(async (id) => {
      const bridge = (
        globalThis as unknown as { ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean }> } }
      ).ow;
      return bridge.execute('block.indent', { id });
    }, child.id);
    expect(indented.ok).toBe(true);

    // Dropping a parent onto its own child would detach the subtree from the
    // page. moveBlock refuses it; this asserts the refusal reaches the caller
    // rather than throwing inside the renderer.
    const bad = await moveTo(window, parent.id, child.id, 'before');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('subtree');
  } finally {
    await cleanup();
  }
});

test('Escape narrows a multi-block selection to the caret block', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'escape', [
      { type: 'paragraph', text: 'one' },
      { type: 'paragraph', text: 'two' },
      { type: 'paragraph', text: 'three' },
    ]);

    const blocks = window.locator('.ow-block');
    await blocks.nth(0).locator('.ow-block-gutter').click();
    await blocks.nth(2).locator('.ow-block-gutter').click({ modifiers: ['Shift'] });
    await expect(window.locator('.ow-block[data-selected="true"]')).toHaveCount(3);

    // Focus the middle block, then Escape. Clearing the selection outright would
    // lose it; narrowing to the block the caret is in is what Escape means here.
    await blocks.nth(1).locator('.ow-block-text').click({ modifiers: ['Shift'] });
    await window.keyboard.press('Escape');
    await expect(window.locator('.ow-block[data-selected="true"]')).toHaveCount(1);
  } finally {
    await cleanup();
  }
});

test('the gutter is a drag handle and carries a plus', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'gutter', [{ type: 'paragraph', text: 'first' }]);
    const gutter = window.locator('.ow-block').first().locator('.ow-block-gutter');
    await expect(gutter).toHaveAttribute('draggable', 'true');
    await expect(gutter.locator('.ow-block-add')).toHaveCount(1);
  } finally {
    await cleanup();
  }
});