/**
 * Reference-shaped screenshots, taken by the app's own e2e harness.
 *
 * These exist so a change to the shell can be compared against the reference
 * frame rather than described. `analysis/ref/block-types.png` is the reference;
 * `docs/images/ui-shell.png` is ours, on the same content, so the two can be put
 * side by side and the difference is visible rather than asserted.
 *
 * Every screenshot goes through the real app on a throwaway workspace, so what
 * lands in docs/images is what a user gets -- not a mockup.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/** The same block ladder the reference frame shows, in the same order. */
const SHOWCASE: { type: string; text: string }[] = [
  { type: 'heading1', text: 'Heading 1' },
  { type: 'heading2', text: 'Heading 2' },
  { type: 'heading3', text: 'Heading 3' },
  {
    type: 'paragraph',
    text: 'This is a paragraph of text. It sits on its own and flows naturally with the content around it.',
  },
  { type: 'bulletedListItem', text: 'Bulleted list item' },
  { type: 'numberedListItem', text: 'Numbered list item' },
  { type: 'todo', text: 'To-do item' },
  { type: 'quote', text: 'This is a quote block — great for highlighting a key idea or passage.' },
  { type: 'code', text: 'print("Hello")' },
];

test('shell screenshot', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await window.evaluate(async (blocks) => {
      const bridge = (
        globalThis as unknown as {
          ow: {
            execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }>;
          };
        }
      ).ow;
      const page = await bridge.execute('page.create', { title: 'Block Type Showcase' });
      await bridge.execute('page.open', { id: page.value.id });
      for (const b of blocks as { type: string; text: string }[]) {
        await bridge.execute('block.insert', { type: b.type, text: b.text });
      }
    }, SHOWCASE);

    await expect(window.locator('.ow-block-heading1')).toBeVisible();
    await window.waitForTimeout(400);
    await window.screenshot({ path: 'docs/images/ui-shell.png' });
  } finally {
    await cleanup();
  }
});

test('settings screenshot', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await window.locator('.ow-settings-open').click();
    await expect(window.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await window.waitForTimeout(300);
    await window.screenshot({ path: 'docs/images/ui-settings.png' });
  } finally {
    await cleanup();
  }
});

test('sidebar has no inline settings panel', async () => {
  const { window, cleanup } = await launchApp();
  try {
    // The regression this guards: six labelled control groups used to sit in the
    // sidebar body, under the page tree, pushing the navigation itself down. The
    // tree is what the sidebar is for.
    //
    // Counted with the dialog closed on purpose -- inside an open Settings dialog
    // these controls exist, which is the whole point of moving them.
    const sidebar = window.locator('.ow-sidebar');
    await expect(sidebar.locator('[aria-label="Text size"]')).toHaveCount(0);
    await expect(sidebar.locator('[aria-label="Content width"]')).toHaveCount(0);
    await expect(sidebar.locator('[aria-label="Accent colour"]')).toHaveCount(0);
    await expect(sidebar.locator('.ow-appearance-label')).toHaveCount(0);

    // And the page tree is still in the sidebar, above the footer.
    await expect(sidebar.locator('.ow-section', { hasText: 'Pages' })).toBeVisible();
    await expect(sidebar.locator('.ow-settings-open')).toBeVisible();
  } finally {
    await cleanup();
  }
});
