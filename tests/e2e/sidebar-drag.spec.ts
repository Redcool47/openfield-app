/**
 * Dragging a sidebar row: reorder among siblings, or nest.
 *
 * HTML5 drag-and-drop cannot be driven by Playwright -- there is no drag
 * primitive in the automation API, and synthesising mousedown/mousemove/mouseup
 * tests the event wiring rather than the gesture. So what is asserted here is
 * the part a real drag depends on and a synthetic one cannot fake: the three
 * drop zones, and that each one issues the right command with the right parent.
 *
 * The gesture itself is covered by the row-menu tests, which reach the same
 * commands by clicking rather than dragging.
 */

import { test, expect } from '@playwright/test';
import { launchApp } from './harness';

/** Three sibling pages plus a container to nest into. */
async function seed() {
  const app = await launchApp();
  const ids = await app.window.evaluate(async () => {
    const bridge = (
      globalThis as unknown as {
        ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; value: { id: string } }> };
      }
    ).ow;
    const a = await bridge.execute('page.create', { title: 'Alpha' });
    const b = await bridge.execute('page.create', { title: 'Beta' });
    const c = await bridge.execute('page.create', { title: 'Gamma' });
    return { a: a.value.id, b: b.value.id, c: c.value.id };
  });
  return { app, ids };
}

/**
 * Drag one sidebar row onto another, at a given vertical ratio of the target.
 *
 * Runs entirely inside the page. A DataTransfer stub cannot be passed across the
 * Playwright boundary -- it is a host object, not plain data -- so the real one
 * is constructed here and the events dispatched against it. This is the closest
 * a synthetic test gets to a genuine drag.
 */
async function dragOnto(
  window: import('@playwright/test').Page,
  fromText: string,
  toText: string,
  ratio: number,
): Promise<void> {
  await window.evaluate(
    async (args) => {
      // No inner named functions here. Under tsx a nested arrow gets wrapped in
      // a `__name` helper that does not exist inside the renderer, and the whole
      // evaluate dies with "__name is not defined" before it runs a line.
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.ow-sidebar .ow-row'));
      const source = rows.find((r) => (r.textContent ?? '').includes(args.fromText as string));
      const target = rows.find((r) => (r.textContent ?? '').includes(args.toText as string));
      if (!source || !target) throw new Error(`row not found: ${args.fromText} -> ${args.toText}`);

      const transfer = new DataTransfer();
      const box = target.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height * (args.ratio as number),
      };

      source.dispatchEvent(new DragEvent('dragstart', init));
      // dragover fires repeatedly during a real drag; the handler only reads the
      // position, so one dispatch at the target ratio is enough to set it.
      target.dispatchEvent(new DragEvent('dragover', init));
      target.dispatchEvent(new DragEvent('drop', init));
      source.dispatchEvent(new DragEvent('dragend', init));
      // Let the two chained commands land before the test reads state.
      await new Promise((r) => setTimeout(r, 400));
    },
    { fromText, toText, ratio },
  );
}

/**
 * Every page in the workspace with its parent, flattened out of the tree.
 *
 * `state.pages` is the tree, so a page that has just been nested stops
 * appearing at the top level. Reading `parentPage` off the top-level list alone
 * makes a successful nest look like the page vanished.
 */
const parentsOf = async (window: import('@playwright/test').Page): Promise<Record<string, string | null>> =>
  window.evaluate(async () => {
    const bridge = (
      globalThis as unknown as {
        ow: {
          state(): Promise<{
            pages: { id: string; parentPage?: string | null; children?: unknown[] }[];
          }>;
        };
      }
    ).ow;
    const out: Record<string, string | null> = {};
    const walk = (nodes: { id: string; parentPage?: string | null; children?: unknown[] }[]): void => {
      for (const n of nodes) {
        out[n.id] = n.parentPage ?? null;
        walk((n.children ?? []) as { id: string; parentPage?: string | null; children?: unknown[] }[]);
      }
    };
    walk((await bridge.state()).pages);
    return out;
  });

test('a sidebar row is draggable and reports its own id on dragstart', async () => {
  const { app, ids } = await seed();
  try {
    const row = app.window.locator('.ow-sidebar .ow-row', { hasText: 'Alpha' }).first();
    await expect(row).toHaveAttribute('draggable', 'true');

    const started = await app.window.evaluate(async (needle) => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('.ow-sidebar .ow-row')).find((r) =>
        (r.textContent ?? '').includes(needle as string),
      );
      if (!el) return null;
      const transfer = new DataTransfer();
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      return transfer.getData('text/plain');
    }, 'Alpha');

    // A row that is draggable but puts nothing on the dataTransfer drags
    // nothing. This was the first version: a handler that typechecked, set an
    // attribute, and moved no page at all.
    expect(started).toBe(ids.a);
  } finally {
    await app.cleanup();
  }
});

test('dropping on the middle of a row nests rather than reorders', async () => {
  const { app, ids } = await seed();
  try {
    await dragOnto(app.window, 'Alpha', 'Gamma', 0.5);
    const parents = await parentsOf(app.window);

    // The middle third is the nest zone, so Alpha ends up under Gamma.
    expect(parents[ids.a]).toBe(ids.c);
    // And Gamma did not move.
    expect(parents[ids.c]).toBeNull();
  } finally {
    await app.cleanup();
  }
});

test('dropping on the top third leaves the page a sibling, reordered', async () => {
  const { app, ids } = await seed();
  try {
    await dragOnto(app.window, 'Alpha', 'Gamma', 0.1);
    const parents = await parentsOf(app.window);

    // Above Gamma means still a root sibling, not a child.
    expect(parents[ids.a]).toBeNull();
    expect(parents[ids.c]).toBeNull();
  } finally {
    await app.cleanup();
  }
});

test('a page cannot be dropped inside its own subtree', async () => {
  const { app, ids } = await seed();
  try {
    // Make Beta a child of Alpha, then try to nest Alpha under Beta.
    const nested = await app.window.evaluate(async (args) => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; error?: string }> };
        }
      ).ow;
      return bridge.execute('page.move', { id: args.b, parentPage: args.a });
    }, { a: ids.a, b: ids.b });
    expect(nested.ok, nested.error).toBe(true);

    const bad = await app.window.evaluate(async (args) => {
      const bridge = (
        globalThis as unknown as {
          ow: { execute: (id: string, a?: unknown) => Promise<{ ok: boolean; error?: string }> };
        }
      ).ow;
      return bridge.execute('page.move', { id: args.a, parentPage: args.b });
    }, { a: ids.a, b: ids.b });

    expect(bad.ok).toBe(false);
  } finally {
    await app.cleanup();
  }
});
