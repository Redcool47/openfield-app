/**
 * The slash menu: registry-generated, alias-aware, keyboard-driven, caret-anchored.
 *
 * Four things this guards, all of which were true of the version before:
 *
 * - The list came from a hand-written array. A block type added to the registry
 *   was invisible in the menu, and the two lists drifted silently.
 * - Filtering matched the label only, so `/h1` found nothing even though the
 *   menu displayed the alias. The alias words were decoration.
 * - Only Escape was handled. Arrow keys and Enter went to the block, so the
 *   menu was mouse-only.
 * - The menu was positioned by CSS at the block's corner, which looks right for
 *   an empty block and opens a screen away for anything else.
 */

import { test, expect } from '@playwright/test';
import { launchApp, seedPage } from './harness';

test('slash menu filters by alias and is fully keyboard-driven', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'slash');
    const block = window.locator('.ow-block-text').first();
    await block.click();
    await block.press('/');
    await expect(window.locator('.ow-slash')).toBeVisible();

    // An alias narrows the list. The menu shows these words, so it has to
    // match them; before, "/h1" matched nothing at all.
    await block.press('h');
    await block.press('1');
    await expect(window.locator('.ow-slash-item')).toHaveCount(1);
    await expect(window.locator('.ow-slash-label')).toHaveText('Heading 1');

    // ArrowDown and Enter pick without a mouse. The first row starts selected.
    await expect(window.locator('.ow-slash-item[aria-selected="true"]')).toHaveCount(1);
    await window.keyboard.press('Enter');
    await expect(window.locator('.ow-slash')).toHaveCount(0);

    // The block became a heading, which is the only proof that Enter did more
    // than close the menu.
    await expect(window.locator('.ow-block').first()).toHaveAttribute('data-type', 'heading1');
  } finally {
    await cleanup();
  }
});

test('typing the word todo finds the to-do block', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'todo');
    const block = window.locator('.ow-block-text').first();
    await block.click();
    await block.press('/');
    await block.press('t');
    await block.press('o');
    await block.press('d');
    await block.press('o');

    // The label is "To-do list". Matching the label alone made the word everyone
    // actually types find nothing, so Enter inserted a line break and left the
    // literal "/todo" in the document.
    await expect(window.locator('.ow-slash-item')).toHaveCount(1);
    await expect(window.locator('.ow-slash-label')).toHaveText('To-do list');
    await window.keyboard.press('Enter');
    await expect(window.locator('.ow-block').first()).toHaveAttribute('data-type', 'todo');
    await expect(window.locator('.ow-block-text').first()).toHaveText('');
  } finally {
    await cleanup();
  }
});

test('arrow keys move the highlighted row', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'arrows');
    const block = window.locator('.ow-block-text').first();
    await block.click();
    await block.press('/');
    await expect(window.locator('.ow-slash')).toBeVisible();

    const first = await window.locator('.ow-slash-label').first().textContent();
    await window.keyboard.press('ArrowDown');
    const second = await window.locator('.ow-slash-label').nth(1).textContent();
    await expect(window.locator('.ow-slash-item').nth(1)).toHaveAttribute('aria-selected', 'true');
    expect(second).not.toBe(first);
  } finally {
    await cleanup();
  }
});

test('the menu opens at the caret, not at the block', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'anchor');
    const block = window.locator('.ow-block-text').first();
    await block.click();
    await block.press('/');
    await block.press('h');
    await block.press('e');
    await expect(window.locator('.ow-slash')).toBeVisible();

    // Before, the menu was positioned at the block's top-left with CSS. It is now
    // fixed against a measured caret rect, so it must line up with the line being
    // typed on -- not with the top of the block, which is where "top" looks right
    // for an empty block and wrong for any other.
    const geometry = await window.evaluate(() => {
      const menu = document.querySelector('.ow-slash') as HTMLElement;
      const host = menu.closest('.ow-block')?.querySelector('.ow-block-text') as HTMLElement;
      const m = menu.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      return { menuLeft: m.left, menuTop: m.top, hostLeft: h.left, hostTop: h.top, position: getComputedStyle(menu).position };
    });

    expect(geometry.position).toBe('fixed');
    // Within a few pixels of the host's left edge: the caret is at the start of
    // the text, so an anchored menu cannot be anywhere else.
    expect(Math.abs(geometry.menuLeft - geometry.hostLeft)).toBeLessThan(24);
    // And below the line it belongs to, not above it.
    expect(geometry.menuTop).toBeGreaterThanOrEqual(geometry.hostTop);
  } finally {
    await cleanup();
  }
});

test('backspacing past the slash closes the menu', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'backspace');
    const block = window.locator('.ow-block-text').first();
    await block.click();
    await block.press('/');
    await expect(window.locator('.ow-slash')).toBeVisible();

    // Closing is not a separate rule: the menu is recomputed from the caret on
    // every input, so removing the slash makes it disappear by itself.
    await block.press('Backspace');
    await expect(window.locator('.ow-slash')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});