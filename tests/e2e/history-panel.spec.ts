/**
 * The version-history panel.
 *
 * What is asserted here is the part that is the panel's own: it opens, and it
 * lists the versions the model recorded. The restore round-trip is asserted in
 * the unit tests, where it is deterministic.
 *
 * The split is deliberate. A version is captured at the start of a burst of edits
 * and at the end of it, and the second one is written by a timer, so the list
 * grows at a moment of its own choosing. Asserting the *content* of a
 * particular row through the panel therefore means racing that timer, and the
 * race is in the test rather than in the feature.
 */

import { test, expect, type Page } from '@playwright/test';
import { launchApp } from './harness';

/** The page options menu, then "Version history". */
async function openHistory(window: Page): Promise<void> {
  await window.locator('[aria-label="Page options"]').click();
  await window.getByRole('menuitem', { name: 'Version history' }).click();
}

/** Wait until the version count stops changing. */
async function waitForVersionsSettled(window: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const count = await window.evaluate(async () => {
          const bridge = (
            globalThis as unknown as {
              ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value?: { versions: unknown[] } }> };
            }
          ).ow;
          const result = await bridge.execute('history.versions.list', {});
          return result.ok ? (result.value?.versions.length ?? 0) : 0;
        });
        const previous = await window.evaluate(() => (window as any).__lastVersionCount ?? -1);
        await window.evaluate((c) => {
          (window as any).__lastVersionCount = c;
        }, count);
        return previous === count && count > 0;
      },
      { timeout: 20_000, intervals: [300] },
    )
    .toBe(true);
}

/** A page holding one paragraph, open, with the version list settled. */
async function seeded(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const bridge = (
      globalThis as unknown as {
        ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }> };
      }
    ).ow;
    const page = await bridge.execute('page.create', { title: 'History' });
    await bridge.execute('page.open', { id: page.value.id });
    await bridge.execute('block.insert', { type: 'paragraph', text: 'the first wording' });
  });
  // A deliberate pause, because that is what starts a new run of edits and
  // therefore what captures a version. The window is 400ms; a test that polls
  // faster than that is a faster typist than any person, and the second edit
  // would be part of the same run rather than a new one.
  await window.waitForTimeout(600);
  await waitForVersionsSettled(window);
}

test('the panel lists the versions the page recorded', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seeded(window);
    // Change the page, so there is more than one state to list.
    await window.evaluate(async () => {
      const bridge = (
        globalThis as unknown as {
          ow: {
            execute: (id: string, a?: unknown) => Promise<{ ok: boolean }>;
            state(): Promise<{ current: { rows: { id: string; text: string }[] } }>;
          };
        }
      ).ow;
      const state = await bridge.state();
      const target = state.current.rows.find((r) => r.text === 'the first wording');
      if (!target) throw new Error('the paragraph was not found');
      await bridge.execute('block.setText', { id: target.id, text: 'completely different now' });
    });
    await waitForVersionsSettled(window);

    await openHistory(window);
    const panel = window.getByRole('dialog', { name: 'Version history' });
    await expect(panel).toBeVisible();

    // More than one: a burst records the state before it and the state it became.
    const items = panel.locator('.ow-history-item');
    await expect.poll(() => items.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

    // Each row says when it was, so the list is readable rather than a column of
    // identifiers.
    await expect(items.first()).not.toBeEmpty();
  } finally {
    await cleanup();
  }
});

test('the panel closes again', async () => {
  const { window, cleanup } = await launchApp();
  try {
    await seeded(window);
    await openHistory(window);
    const panel = window.getByRole('dialog', { name: 'Version history' });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'Close version history' }).click();
    await expect(window.getByRole('dialog', { name: 'Version history' })).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
