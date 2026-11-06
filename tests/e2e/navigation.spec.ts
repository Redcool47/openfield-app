/**
 * Back, forward, and the ancestor breadcrumb.
 *
 * The history trail lives in the renderer and every open goes through it, so
 * this exercises the path a user actually takes: open two pages, go back, go
 * forward. Nothing here can be checked by reading the code, and the easy failure
 * is silent -- a Back button that does nothing looks exactly like one that
 * worked when the page it should have returned to is already on screen.
 *
 * Titles carry a per-run marker because the e2e workspace is shared across runs:
 * fixed titles accumulate, and an exact-title lookup would then match the page
 * created by the previous run instead of this one.
 */

import { _electron as electron } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const electronMain = join(process.cwd(), 'apps', 'desktop', 'dist', 'main', 'index.js');

type BridgeResult<T> = { ok: boolean; value: T; error?: string };

/** One command through the preload bridge, typed at the call site. */
const run = <T>(
  window: import('@playwright/test').Page,
  id: string,
  args?: unknown,
): Promise<BridgeResult<T>> =>
  window.evaluate(
    async ([command, a]) => {
      const bridge = (globalThis as unknown as {
        ow: { execute: (id: string, args?: unknown) => Promise<BridgeResult<unknown>> };
      }).ow;
      return bridge.execute(command, a);
    },
    [id, args] as const,
  ) as Promise<BridgeResult<T>>;

test('back and forward walk the pages opened in this session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ow-nav-'));
  const app = await electron.launch({ args: [electronMain, '--user-data-dir', dir] });
  const window = await app.firstWindow();
  await window.bringToFront();
  try {
    await expect(window.locator('.ow-app')).toBeVisible();

    const stamp = Date.now().toString(36);
    const parent = `${stamp}-parent`;
    const first = `${stamp}-first`;
    const second = `${stamp}-second`;

    await run<{ id: string }>(window, 'page.create', { title: parent });
    // quickFind returns pageId, not id; the lookup is by title and there is
    // exactly one because the marker is unique to this run.
    const found = (
      await run<{ pageId: string; title: string }[]>(window, 'search.quickFind', { query: parent })
    ).value.find((h) => h.title === parent);
    expect(found, 'the parent page was created').toBeTruthy();

    await run(window, 'page.create', { title: first, parentPage: found!.pageId });
    await run(window, 'page.create', { title: second, parentPage: found!.pageId });
    // Wait for the rows rather than clicking blind: the sidebar re-renders from
    // the state push, and the click has to land on the row that exists.
    await expect(window.locator('.ow-sidebar').locator('.ow-row-main').filter({ hasText: second })).toBeVisible();

    // Pages are opened by clicking the sidebar rows, not through the bridge.
    // Driving the UI is the point of an e2e: the bridge is reachable from
    // `page.evaluate` but the navigation trail is a React closure, so a test that
    // used the bridge would be asserting on state the app never sees.
    const row = (title: string) => window.locator('.ow-sidebar').locator('.ow-row-main').filter({ hasText: title });
    await row(first).click();
    await expect(window.locator('.ow-crumb-current')).toHaveText(first);

    await row(second).click();
    await expect(window.locator('.ow-crumb-current')).toHaveText(second);

    // The breadcrumb names the ancestor, and it is a link to it.
    await expect(
      window.locator('.ow-breadcrumb').getByRole('button', { name: parent }),
    ).toBeVisible();

    // Back returns to the first page.
    await window.locator('.ow-topbar').getByRole('button', { name: 'Back' }).click();
    await expect(window.locator('.ow-crumb-current')).toHaveText(first);

    // Forward returns to the second, which is the whole point of the pair.
    await window.locator('.ow-topbar').getByRole('button', { name: 'Forward' }).click();
    await expect(window.locator('.ow-crumb-current')).toHaveText(second);

    // Once the trail is exhausted the button stays put and stops working, rather
    // than vanishing and shifting the neighbours. Asserted directly rather than
    // by clicking it again: Playwright waits for a button to become enabled
    // before clicking, so clicking a disabled button is an unconditional timeout
    // and the assertion it would have made is never reached.
    await expect(window.locator('.ow-topbar').getByRole('button', { name: 'Forward' })).toBeDisabled();

    // Ctrl+[ is the same action as the button.
    await window.keyboard.press('Control+[');
    await expect(window.locator('.ow-crumb-current')).toHaveText(first);
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
