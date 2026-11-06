/**
 * The inline syntaxes, as the user meets them.
 *
 * The unit tests check the rules and the commands. This checks the thing that
 * matters: that a person who types an equation gets an equation, and not the
 * characters they typed.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

test.describe('inline syntaxes', () => {
  test('an equation is drawn as an equation', async () => {
    const { window, cleanup } = await launchApp();
    try {
      await window.keyboard.press('Control+n');
      const editor = window.getByRole('textbox', { name: 'paragraph' }).first();
      await expect(editor).toBeVisible();
      await editor.click();

      await editor.type('cost is $x^2$');
      // The rule fires on the closing dollar sign.
      const equation = window.locator('[data-inline="equation"]');
      await expect(equation).toHaveCount(1);
      // And it is drawn as an equation: a superscript, not the characters.
      await expect(equation.locator('sup')).toHaveText('2');
      // The source is still available for the reader who wants it.
      await expect(equation).toHaveAttribute('title', 'x^2');
    } finally {
      await cleanup();
    }
  });

  test('a tag is drawn as a tag, with its hash', async () => {
    const { window, cleanup } = await launchApp();
    try {
      await window.keyboard.press('Control+n');
      const editor = window.getByRole('textbox', { name: 'paragraph' }).first();
      await expect(editor).toBeVisible();
      await editor.click();

      await editor.type('ship it #urgent ');
      const tag = window.locator('[data-inline="tag"]');
      await expect(tag).toHaveCount(1);
      await expect(tag).toHaveText('#urgent');
    } finally {
      await cleanup();
    }
  });

  test('a wiki link to a page that exists becomes a link to it', async () => {
    const { window, cleanup } = await launchApp();
    try {
      // A page to link to.
      await window.evaluate(async () => {
        const ow = (
          globalThis as unknown as {
            ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }> };
          }
        ).ow;
        const page = await ow.execute('page.create', { title: 'The Plan' });
        await ow.execute('page.open', { id: page.value.id });
      });

      const editor = window.getByRole('textbox', { name: 'paragraph' }).first();
      await editor.click();
      await editor.type('see [[The Plan]]');

      const link = window.locator('[data-inline="page"]');
      await expect(link).toHaveCount(1);
      await expect(link).toHaveText('The Plan');
    } finally {
      await cleanup();
    }
  });

  test('a wiki link to a page that does not exist stays as text', async () => {
    const { window, cleanup } = await launchApp();
    try {
      await window.keyboard.press('Control+n');
      const editor = window.getByRole('textbox', { name: 'paragraph' }).first();
      await expect(editor).toBeVisible();
      await editor.click();

      await editor.type('see [[Nowhere]]');
      // A link to nothing is worse than text.
      await expect(window.locator('[data-inline="page"]')).toHaveCount(0);
      await expect(editor).toContainText('[[Nowhere]]');
    } finally {
      await cleanup();
    }
  });
});
