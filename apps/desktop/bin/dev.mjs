#!/usr/bin/env node
/**
 * Development and build runner.
 *
 * Two build tools, chosen deliberately:
 *
 *  - **esbuild** for the main process and the preload. Both are plain Node
 *    targets with no JSX, and esbuild transpiles TypeScript and emits CommonJS
 *    in one step with no plugin chain to misconfigure. Vite's library mode was
 *    tried first and silently passed the workspace `.ts` sources through
 *    untranspiled, which only surfaced as a rollup parse error deep inside the
 *    build.
 *
 *  - **Vite** for the renderer, because it handles JSX, CSS imports and asset
 *    URLs properly and has a dev server we may want later.
 *
 * The preload is bundled to a **single self-contained CommonJS file**. That is
 * not a preference: a sandboxed preload script runs with a polyfilled `require`
 * that resolves nothing on disk, so a relative import in the preload bundle
 * would fail at runtime in a way that is hard to trace.
 *
 * The renderer is loaded over `file://` in development too, not from a dev
 * server, so the Content-Security-Policy is byte-identical in both modes and a
 * development-only hole can never be mistaken for a production one.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const repo = join(app, '..', '..');

const nodeModules = join(repo, 'node_modules');
const aliasPlugin = {
  name: 'workspace-alias',
  setup(b) {
    // Workspace packages resolve to their source, so there is no build step to
    // keep in sync between the packages and the app that consumes them.
    const map = {
      '@ow/model': join(repo, 'packages/model/src/index.ts'),
      '@ow/geom': join(repo, 'packages/geom/src/index.ts'),
      '@ow/storage': join(repo, 'packages/storage/src/index.ts'),
      '@ow/commands': join(repo, 'packages/commands/src/index.ts'),
    };
    b.onResolve({ filter: /^@ow\// }, (args) => {
      const target = map[args.path];
      if (target) return { path: target };
      return null;
    });
  },
};

  async function buildMain() {
    console.log('[build] main process');

    // The window icon has to be inside `dist/` because electron-builder packages
    // only `dist/**/*`. Leaving it in `build/` means the packaged app points at a
    // path that does not exist, and the window falls back to Electron's default
    // atom -- which is exactly what the first packaged build shipped with.
    // The operator's artwork when it is there, the generated fallback otherwise.
// Both the packaged exe and the dev window read from dist/build/, so choosing
// the source here covers every place the icon can appear.
const iconSrc = existsSync(join(app, 'build/logo.png'))
  ? join(app, 'build/logo.png')
  : join(app, 'build/icon.png');
    const iconDst = join(app, 'dist/build/icon.png');
    if (existsSync(iconSrc)) {
      mkdirSync(dirname(iconDst), { recursive: true });
      copyFileSync(iconSrc, iconDst);
    }

  console.log('[build] main process');
  await build({
    entryPoints: [join(app, 'src/main/index.ts')],
    outfile: join(app, 'dist/main/index.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: true,
    // Electron is provided by the runtime; bundling it produces a broken app.
    external: ['electron'],
    plugins: [aliasPlugin],
    logLevel: 'warning',
  });
}

async function buildPreload() {
  console.log('[build] preload');
  await build({
    entryPoints: [join(app, 'src/preload/index.ts')],
    outfile: join(app, 'dist/preload/index.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: true,
    external: ['electron'],
    logLevel: 'warning',
  });
}

function buildRenderer() {
  console.log('[build] renderer');
  return new Promise((resolve, reject) => {
    const vite = join(nodeModules, 'vite', 'bin', 'vite.js');
    if (!existsSync(vite)) {
      reject(new Error('vite is not installed. Run: npm install'));
      return;
    }
    const child = spawn(process.execPath, [vite, 'build', '--config', 'vite.renderer.config.ts'], {
      cwd: app,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`renderer build exited ${code}`)),
    );
  });
}

const argv = process.argv.slice(2);
const packageOnly = argv.includes('--package');

await buildMain();
await buildPreload();
await buildRenderer();
mkdirSync(join(app, 'dist'), { recursive: true });

if (packageOnly) {
  console.log('[build] done (no launch)');
  process.exit(0);
}

const electron = join(nodeModules, 'electron', 'dist', 'electron.exe');
const electronPosix = join(nodeModules, 'electron', 'dist', 'electron');
const bin = process.platform === 'win32' ? electron : electronPosix;
if (!existsSync(bin)) {
  console.error('[dev] Electron is not installed. Run: npm install');
  process.exit(2);
}

console.log('[dev] launching');
const child = spawn(bin, [app], { cwd: app, stdio: 'inherit' });
child.on('close', (code) => process.exit(code ?? 0));
