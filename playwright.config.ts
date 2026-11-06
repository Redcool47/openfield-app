import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Only *.spec.ts are Playwright specs. Vitest picks up *.test.ts, so there is
  // no overlap between the two runners.
  testMatch: /.*\.spec\.ts$/,

  // Serial, always. These tests launch a real Electron GUI application, and two
  // of those at once contend for the single-instance lock, the GPU process and
  // the window server. The result was not a clean failure but flakiness: one run
  // had two failures, the next had one, on unchanged code. A suite that is
  // intermittently red is worse than one that is reliably green, because it
  // trains everyone to re-run instead of read.
  //
  // This suite is short and dominated by process startup, so serial costs
  // seconds. If it ever gets slow enough to matter, the fix is more Electron
  // apps per worker, not parallel workers.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // Generous: a cold Electron start on a loaded machine is genuinely slow, and a
  // timeout that fires during startup looks like an application failure.
  timeout: 60_000,
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
