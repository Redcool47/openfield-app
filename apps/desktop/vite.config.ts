import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const alias = (p: string, target: string) => ({ find: p, replacement: r(target) });

/**
 * Three separate builds, because Electron has two very different targets.
 *
 *  - `main`     runs in Node, in the main process. Emits CommonJS-ish ESM that
 *               Electron loads directly.
 *  - `preload`  runs in a sandboxed context. Must be a single self-contained
 *               file: a sandboxed preload cannot make relative imports, because
 *               `require` is polyfilled and resolves nothing on disk.
 *  - `renderer` runs in the browser context and may import the UI kit as source.
 */
export default defineConfig(({ mode }) => ({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: mode !== 'production',
  },
  plugins: [react()],
  resolve: {
    alias: [
      alias('@ow/ui-kit', '../packages/ui-kit/src/index.ts'),
      alias('@ow/model', '../packages/model/src/index.ts'),
      alias('@ow/geom', '../packages/geom/src/index.ts'),
      alias('@ow/storage', '../packages/storage/src/index.ts'),
      alias('@ow/commands', '../packages/commands/src/index.ts'),
    ],
  },
}));