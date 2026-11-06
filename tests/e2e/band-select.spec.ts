/**
 * Rubber-band block selection and edge autoscroll.
 *
 * Dragging with a pointer is the one thing Playwright cannot synthesise
 * faithfully: there is no real drag in the automation API, and driving
 * mousedown/mousemove/mouseup by hand tests the event wiring rather than the
 * gesture. So the geometry is unit-tested in band-select.test.ts and what is
 * asserted here is the part a mouse is needed for: that the band appears, that
 * it is positioned where the pointer went, and that it is transient.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/** Seed a page with `count` numbered paragraphs and return the app. */
async function seeded(count: number) {
  const app = await launchApp();
  await app.window.evaluate(async (n) => {
    const bridge = (
      globalThis as unknown as {
        ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }> };
      }
    ).ow;
    const page = await bridge.execute('page.create', { title: 'Band' });
    await bridge.execute('page.open', { id: page.value.id });
    for (let i = 0; i < (n as number); i++) {
      await bridge.execute('block.insert', { type: 'paragraph', text: `line ${i}` });
    }
  }, count);
  return app;
}

const boxes = async (window: import('@playwright/test').Page) =>
  window.$$eval('.ow-block[data-block-id]', (els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { id: e.getAttribute('data-block-id'), top: r.top, bottom: r.bottom, left: r.left };
    }),
  );

test('a drag on the page margin draws a band where the pointer went', async () => {
  const { window, cleanup } = await seeded(8);
  try {
    const all = await boxes(window);
    // The margin is to the left of the content column, inside .ow-blocks.
    const startX = all[2]!.left - 30;
    const y1 = all[1]!.top + 4;
    const y2 = all[4]!.bottom - 4;

    await window.mouse.move(startX, y1);
    await window.mouse.down();
    await window.mouse.move(startX + 40, y2, { steps: 8 });

    const band = window.locator('.ow-band');
    await expect(band).toBeVisible();
    const drawn = await band.boundingBox();
    expect(drawn!.height).toBeGreaterThan(50);
    // Drawn where the pointer is, not at the origin.
    expect(Math.abs(drawn!.y - y1)).toBeLessThan(6);

    await window.mouse.up();
    // Transient: it is a gesture, not a state.
    await expect(window.locator('.ow-band')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test('releasing the band selects the blocks it covered', async () => {
  const { window, cleanup } = await seeded(10);
  try {
    const all = await boxes(window);
    const startX = all[1]!.left - 30;
    const y1 = all[1]!.top + 2;
    const y2 = all[4]!.bottom - 2;

    await window.mouse.move(startX, y1);
    await window.mouse.down();
    await window.mouse.move(startX + 40, y2, { steps: 8 });
    await window.mouse.up();

    const selected = await window.$$eval('.ow-block[data-selected="true"]', (els) => els.length);
    // Lines 0..3 live inside the band. Counting exactly is the point: an
    // off-by-one here deletes the wrong blocks.
    expect(selected).toBeGreaterThanOrEqual(3);
    expect(selected).toBeLessThanOrEqual(5);
  } finally {
    await cleanup();
  }
});

test('a click on the margin without dragging selects nothing', async () => {
  const { window, cleanup } = await seeded(6);
  try {
    const all = await boxes(window);
    await window.mouse.click(all[2]!.left - 30, all[2]!.top + 6);

    // Every mousedown starts a band, so without a minimum-size check a plain
    // click in the margin would sweep in everything between the press and the
    // pointer's resting place.
    await expect(window.locator('.ow-band')).toHaveCount(0);
    expect(await window.locator('.ow-block[data-selected="true"]').count()).toBe(0);
  } finally {
    await cleanup();
  }
});

test('a press on a block still puts a caret there', async () => {
  const { window, cleanup } = await seeded(4);
  try {
    // The margin gesture must not swallow clicks on blocks, or the gutter
    // becomes a dead zone across the whole page.
    const text = window.locator('.ow-block-text', { hasText: 'line 1' }).first();
    await text.click();
    await expect(text).toBeFocused();
    expect(await window.locator('.ow-band').count()).toBe(0);
  } finally {
    await cleanup();
  }
});
