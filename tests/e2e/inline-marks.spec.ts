/**
 * Inline marks, asserted on the screen rather than in the model.
 *
 * Every previous mark test checked the model after the command and stopped
 * there. That is how bold, italic, strikethrough, code and links all shipped in
 * a state where the command succeeded, the data was correct, and nothing at all
 * appeared: the block rendered as a plain contenteditable with textContent.
 *
 * Each assertion below reads a computed style. A test that reads the database
 * proves the command ran; only a computed style proves the user can see it.
 */

import { test, expect } from '@playwright/test';
import { launchApp, seedPage } from './harness';

/** The open page's first non-empty block id. */
const firstBlockId = async (window: import('@playwright/test').Page): Promise<string> => {
  const rows = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { ow: { state(): Promise<{ current: { rows: { id: string; text: string }[] } }> } }).ow;
    return (await bridge.state()).current.rows.map((r) => ({ id: r.id, text: r.text }));
  });
  return rows.find((r) => r.text !== '')!.id;
};

const mark = async (window: import('@playwright/test').Page, id: string, command: string, from = 0, to = 4) =>
  window.evaluate(
    async (args) => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; error?: string }> };
        }
      ).ow;
      return bridge.execute(args.command, { id: args.id, from: args.from, to: args.to });
    },
    { id, command, from, to },
  );

test('bold, italic and strikethrough are drawn, not just stored', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'marks', [{ type: 'paragraph', text: 'marked' }]);
    const id = await firstBlockId(window);

    for (const [command, property, value] of [
      ['mark.bold.toggle', 'fontWeight', '700'],
      ['mark.italic.toggle', 'fontStyle', 'italic'],
      ['mark.strikethrough.toggle', 'textDecorationLine', 'line-through'],
    ] as const) {
      expect((await mark(window, id, command)).ok).toBe(true);
    }

    // Blur is what swaps the plain editing text for the drawn runs.
    await window.locator('.ow-page-title').click();
    await expect(window.locator('.ow-block-text').first()).toBeVisible();

    const styles = await window.evaluate(() => {
      const spans = document.querySelectorAll('.ow-block-text [data-mark]');
      const seen: Record<string, string> = {};
      for (const s of spans) {
        const cs = getComputedStyle(s);
        seen[cs.fontWeight === '700' ? 'bold' : ''] = 'bold';
        seen[cs.fontStyle === 'italic' ? 'italic' : ''] = 'italic';
        if (cs.textDecorationLine.includes('line-through')) seen['strike'] = 'strike';
      }
      return seen;
    });

    expect(Object.keys(styles)).toEqual(expect.arrayContaining(['bold', 'italic', 'strike']));
  } finally {
    await cleanup();
  }
});

test('a link is drawn with the accent colour and an underline', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'links', [{ type: 'paragraph', text: 'click here' }]);
    const id = await firstBlockId(window);

    const applied = await window.evaluate(
      async (blockId) => {
        const bridge = (
          globalThis as unknown as {
            ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; error?: string }> };
          }
        ).ow;
        return bridge.execute('mark.link.set', { id: blockId, from: 0, to: 5, href: 'https://example.org' });
      },
      id,
    );
    expect(applied.ok, applied.error).toBe(true);

    await window.locator('.ow-page-title').click();
    const link = window.locator('.ow-block-text [data-link]').first();
    await expect(link).toHaveText('click');

    const style = await link.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { underline: cs.textDecorationLine, colour: cs.color, tag: el.tagName };
    });
    expect(style.underline).toContain('underline');
    // A span, not an anchor: an anchor inside a contenteditable swallows the
    // click and the caret can never be placed inside a linked word.
    expect(style.tag).toBe('SPAN');
    expect(style.colour).not.toBe('rgb(0, 0, 0)');
  } finally {
    await cleanup();
  }
});

test('mark.link.set refuses a script scheme', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'scheme', [{ type: 'paragraph', text: 'payload' }]);
    const id = await firstBlockId(window);

    // javascript: in a contenteditable is script execution with a click.
    const bad = await window.evaluate(
      async (blockId) => {
        const bridge = (
          globalThis as unknown as {
            ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; error?: string }> };
          }
        ).ow;
        return bridge.execute('mark.link.set', { id: blockId, from: 0, to: 7, href: 'javascript:alert(1)' });
      },
      id,
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('javascript');
  } finally {
    await cleanup();
  }
});

test('an empty href removes the link rather than setting a blank one', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seedPage(window, 'unlink', [{ type: 'paragraph', text: 'plain text' }]);
    const id = await firstBlockId(window);

    await window.evaluate(
      async (blockId) => {
        const bridge = (
          globalThis as unknown as {
            ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean }> };
          }
        ).ow;
        await bridge.execute('mark.link.set', { id: blockId, from: 0, to: 5, href: 'https://example.org' });
        await bridge.execute('mark.link.set', { id: blockId, from: 0, to: 5, href: '' });
      },
      id,
    );

    await window.locator('.ow-page-title').click();
    await expect(window.locator('.ow-block-text [data-link]')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
