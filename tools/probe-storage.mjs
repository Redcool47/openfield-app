#!/usr/bin/env node
/**
 * Does the packaged renderer actually have working localStorage?
 *
 * The renderer is loaded with `loadFile`, so it runs on a `file://` origin, where
 * Chromium may refuse storage entirely. That failure is silent by design in
 * `preferences.ts` -- a window with unreadable preferences still opens, it just
 * forgets them -- which makes it exactly the kind of defect that ships looking
 * fine and is noticed weeks later when the theme keeps resetting.
 *
 * So this checks it against the real packaged build rather than reasoning about
 * it. It also verifies a write survives a reload, since a store that reads but
 * refuses to persist is the other half of the same problem.
 *
 * Usage: node tools/probe-storage.mjs [--dev]
 */

import { _electron as electron } from 'playwright';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const root = process.cwd();
const exe = join(root, 'release', 'win-unpacked', 'Openfield.exe');

if (!existsSync(exe)) {
  console.error(`no packaged build at ${exe}`);
  console.error('run: node apps/desktop/bin/dev.mjs --package');
  console.error('then: cd apps/desktop && electron-builder --dir');
  process.exit(2);
}

const app = await electron.launch({ executablePath: exe, args: ['--no-sandbox'] });

try {
  const page = await app.firstWindow({ timeout: 30_000 });

  // What origin are we actually on? Everything else follows from this.
  const origin = await page.evaluate(() => globalThis.location.origin);
  console.log(`origin: ${origin}`);

  // Can we write, then read back within the same document?
  const written = await page.evaluate(() => {
    try {
      globalThis.localStorage.setItem('openfield.probe', 'written');
      return { ok: true, back: globalThis.localStorage.getItem('openfield.probe') };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  console.log(`write + read in one document: ${JSON.stringify(written)}`);

  // Does it survive a reload? Storage that only lives in memory is not storage.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const afterReload = await page.evaluate(() => {
    try {
      return { ok: true, back: globalThis.localStorage.getItem('openfield.probe') };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  console.log(`survives a reload:           ${JSON.stringify(afterReload)}`);

  // And does the app's own preference read work?
  const prefs = await page.evaluate(() => {
    try {
      return { ok: true, raw: globalThis.localStorage.getItem('openfield.preferences') };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  console.log(`preferences readable:         ${JSON.stringify(prefs)}`);

  const persisted = written.ok && afterReload.ok && afterReload.back === 'written';
  if (!persisted) {
    console.log('');
    console.log('VERDICT: storage does not persist. Preferences would silently reset.');
    process.exitCode = 1;
  } else {
    console.log('');
    console.log(`VERDICT: storage works on ${origin}. Preferences persist.`);
  }
} finally {
  await app.close();
}