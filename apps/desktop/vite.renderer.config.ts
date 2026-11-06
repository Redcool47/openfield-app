import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Renderer build.
 *
 * The `@ow/ui-kit` alias is anchored with `^...$` so it matches only the bare
 * specifier. An unanchored alias also swallows subpath imports, so
 * `@ow/ui-kit/tokens.css` resolved to `index.ts/tokens.css` and the build failed
 * with ENOENT. Subpaths must fall through to the package's own `exports` map,
 * which is where the stylesheet is declared.
 */
export default defineConfig({
  root: r('./src/renderer'),
  // Relative asset base, because the app is loaded over file:// in both modes.
  base: './',
  plugins: [react()],
  build: {
    outDir: r('./dist/renderer'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  resolve: {
    alias: [{ find: /^@ow\/ui-kit$/, replacement: r('../../packages/ui-kit/src/index.ts') }],
  },
});
