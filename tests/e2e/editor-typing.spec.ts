/**
 * Typing is not lost, and the caret does not move.
 *
 * Two defects hid behind each other here, and both are guarded.
 *
 * The first was a dropped character: the block's text is rendered from the
 * model, and a character typed while the command round trip was still in
 * flight was overwritten by the model's older text. The second was a caret
 * that jumped to the start of the block, so the rest of the word was typed
 * there: `Hello Openfield` arrived as `lo OpenfieldHel`.
 *
 * The screen and the model are checked separately. A test that only reads the
 * screen passes with a model that is quietly wrong, and the wrong model is
 * what gets saved.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/** The model text of the first block, read from the pushed state. */
async function modelText(window: Awaited<ReturnType<typeof launchApp>>['window']) {
  return await window.evaluate(async () => {
    const w = window as unknown as {
      ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: unknown }> };
    };
    // `page.history.save` is a harmless read-mostly command; the outline is
    // easier to get from the state push, so ask the renderer for the rows it
    // last received.
    const state = (w as unknown as { __owState?: { current: { rows: { text: string }[] } | null } })
      .__owState;
    return state?.current?.rows.map((r) => r.text) ?? [];
  });
}

test.describe('editor typing', () => {
  test('fast typing lands exactly as typed, on screen and in the model', async () => {
    const { window, cleanup } = await launchApp();
    try {
      // Record every state the renderer receives, so the model can be read
      // without a command that exists only for the test.
      await window.evaluate(() => {
        const w = window as unknown as {
          ow: { onState: (h: (s: unknown) => void) => () => void };
          __owState?: { current: { rows: { text: string }[] } | null };
        };
        w.__owState = { current: null };
        w.ow.onState((s) => {
          w.__owState = s as { current: { rows: { text: string }[] } | null };
        });
      });

      await window.keyboard.press('Control+n');
      const editor = window.getByRole('textbox', { name: 'paragraph' }).first();
      await expect(editor).toBeVisible();
      await editor.click();

      // No delay between characters: this is what puts a keystroke in flight
      // while the previous one is still being processed.
      await editor.type('Hello Openfield');
      await expect(editor).toHaveText('Hello Openfield');

      // The model must agree with the screen. A screen that is right while the
      // model is behind is the same bug seen from the other side.
      await expect.poll(async () => (await modelText(window)).join('|')).toBe('Hello Openfield');

      // Typing on at the end must extend the text, not replace it and not
      // rotate it.
      await editor.type(' again');
      await expect(editor).toHaveText('Hello Openfield again');
      await expect.poll(async () => (await modelText(window)).join('|')).toBe('Hello Openfield again');
    } finally {
      await cleanup();
    }
  });

  test('a long word typed in one go is not truncated', async () => {
    const { window, cleanup } = await launchApp();
    try {
      await window.keyboard.press('Control+n');
      const editor = window.getByRole('textbox', { name: 'paragraph' }).first();
      await expect(editor).toBeVisible();
      await editor.click();

      await editor.type('Supercalifragilisticexpialidocious');
      await expect(editor).toHaveText('Supercalifragilisticexpialidocious');
    } finally {
      await cleanup();
    }
  });
});
