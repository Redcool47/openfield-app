/**
 * The floating selection toolbar.
 *
 * The interesting failure is not that the buttons are missing, it is that they
 * appear somewhere other than on top of the text they act on. A stored
 * selection rect is stale the moment the page scrolls, so the toolbar is
 * measured on every render -- the test scrolls and then asserts.
 *
 * Buttons use mousedown rather than click for the same reason: a click anywhere
 * outside a selection collapses it, so a click-driven toolbar destroys the
 * selection it was about to act on.
 */

import { test, expect, type Page } from '@playwright/test';
import { launchApp, seedPage } from './harness';

/**
 * Select the whole of the block whose text contains `needle`.
 *
 * Located by text, never by index. A new page already carries one empty block,
 * and selecting that tests nothing: there is no text in it to select. Shift+End
 * rather than a double click, because synthesised double clicks do not drive
 * Chromium's word-selection path in a contenteditable here.
 */
async function selectBlock(window: Page, needle: string): Promise<void> {
  await window.locator('.ow-block-text', { hasText: needle }).first().click();
  await window.keyboard.press('Home');
  await window.keyboard.press('Shift+End');
  await expect
    .poll(async () => window.evaluate(() => window.getSelection()?.toString().length ?? 0))
    .toBeGreaterThan(0);
}

/** Geometry of the toolbar against the live selection. */
const aligned = (window: Page) =>
  window.evaluate(() => {
    const bar = document.querySelector('.ow-selbar')!.getBoundingClientRect();
    const range = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
    return {
      barTop: bar.top,
      barBottom: bar.bottom,
      barLeft: bar.left,
      selTop: range.top,
      selBottom: range.bottom,
      selRight: range.right,
    };
  });

/**
 * The toolbar must sit against the selection, on whichever side has room.
 *
 * Either side is correct: it flips above when there is not enough room below.
 * What would be wrong is floating somewhere else entirely.
 */
const touches = (g: Awaited<ReturnType<typeof aligned>>) =>
  g.barBottom <= g.selTop + 1 || g.barTop >= g.selBottom - 1;

test('the toolbar appears over a selection, with every action named', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'bar', [{ type: 'paragraph', text: 'select me please' }]);
    await selectBlock(window, 'select me');

    const bar = window.locator('.ow-selbar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('role', 'toolbar');
    await expect(bar.locator('button')).toHaveCount(6);
    // An unlabelled glyph button announces to a screen reader as "button".
    for (const label of ['Bold', 'Italic', 'Strikethrough', 'Code', 'Link', 'Colour']) {
      await expect(bar.getByRole('button', { name: label, exact: true })).toHaveCount(1);
    }
  } finally {
    await cleanup();
  }
});

test('the toolbar sits on its own text and follows the page when it scrolls', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }> };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Scroll' });
      await bridge.execute('page.open', { id: page.value.id });
      for (let i = 0; i < 40; i++) {
        await bridge.execute('block.insert', { type: 'paragraph', text: `filler ${i}` });
      }
    });

    await selectBlock(window, 'filler 30');
    const bar = window.locator('.ow-selbar');
    await expect(bar).toBeVisible();

    const before = await aligned(window);
    // Against the selection, and not further right than it.
    expect(touches(before)).toBe(true);
    expect(before.barLeft).toBeGreaterThanOrEqual(before.selRight - 200);

    // Scroll while keeping the selection. This is the case a stored rect fails:
    // the toolbar holds a position captured when the selection began, the text
    // moves out from under it, and it ends up pointing at whatever scrolled past.
    await window.evaluate(() => document.querySelector('.ow-page-scroll')!.scrollBy(0, 180));
    await window.waitForTimeout(250);
    await expect(bar).toBeVisible();

    const after = await aligned(window);
    expect(touches(after)).toBe(true);
    // The selection moved up the viewport, and so did the toolbar with it.
    expect(after.barTop).toBeLessThan(before.barTop - 100);
  } finally {
    await cleanup();
  }
});

test('pressing Bold on the toolbar marks the selection and draws it', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'apply', [{ type: 'paragraph', text: 'bold me' }]);
    await selectBlock(window, 'bold me');

    const bar = window.locator('.ow-selbar');
    await expect(bar).toBeVisible();
    // mousedown, not click: a real click collapses the selection it targets.
    await bar.getByRole('button', { name: 'Bold', exact: true }).dispatchEvent('mousedown');

    // The mark is in the model...
    const marked = await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: { state(): Promise<{ current: { rows: { runs?: { marks?: string[] }[] }[] } }> };
        }
      ).ow;
      return (await bridge.state()).current.rows.some((r) => r.runs?.some((x) => x.marks?.includes('bold')));
    });
    expect(marked).toBe(true);

    // ...and drawn, which is the part every earlier mark test skipped.
    const bold = window.locator('.ow-block-text [data-mark~="bold"]').first();
    await expect(bold).toBeVisible();
    expect(await bold.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('700');
  } finally {
    await cleanup();
  }
});

test('the toolbar disappears when the selection is collapsed', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'gone', [{ type: 'paragraph', text: 'pick me' }]);
    await selectBlock(window, 'pick me');
    await expect(window.locator('.ow-selbar')).toBeVisible();

    await window.keyboard.press('ArrowRight');
    await expect(window.locator('.ow-selbar')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test('a highlight from the palette reaches the model and is drawn', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'colour', [{ type: 'paragraph', text: 'paint me yellow' }]);
    await selectBlock(window, 'paint me');

    const bar = window.locator('.ow-selbar');
    // Opening the palette must not collapse the selection, which is what a
    // click handler would do; every control here acts on mousedown.
    await bar.getByRole('button', { name: 'Colour', exact: true }).dispatchEvent('mousedown');
    const palette = bar.getByRole('group', { name: 'Colour' });
    await expect(palette).toBeVisible();

    // The Fill row is the second one; both rows contain a swatch per hue, so the
    // swatch is located inside its row rather than by bare label.
    await palette.locator('.ow-selbar-row').nth(1).getByRole('button', { name: 'yellow' }).dispatchEvent('mousedown');

    const stored = await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: {
            state(): Promise<{
              current: { rows: { runs?: { background?: string; text?: string }[] }[] };
            }>;
          };
        }
      ).ow;
      const state = await bridge.state();
      return state.current.rows
        .flatMap((r) => r.runs ?? [])
        .filter((r) => r.background !== undefined)
        .map((r) => ({ text: r.text, background: r.background }));
    });
    // selectBlock selects the whole line, so the highlight covers all of it.
    expect(stored).toEqual([{ text: 'paint me yellow', background: 'yellow' }]);

    // ...and drawn. A stored colour with no rule is invisible, which is the
    // failure mode this asserts against. color-mix means the computed value is
    // not the token hex, so the assertion is that a background exists at all.
    const filled = window.locator('.ow-block-text [data-background="yellow"]').first();
    await expect(filled).toBeVisible();
    const paint = await filled.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(paint).not.toBe('rgba(0, 0, 0, 0)');
  } finally {
    await cleanup();
  }
});
