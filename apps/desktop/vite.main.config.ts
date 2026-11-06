import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const r = (p) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  build: {
    outDir: 'dist/main',
    emptyOutDir: true,
    target: 'node20',
    lib: { entry: r('./src/main/index.ts'), formats: ['es'], fileName: () => 'index.js' },
    rollupOptions: { external: ['electron'] },
  },
  resolve: { alias: [
    { find: '@ow/model', replacement: r('../../packages/model/src/index.ts') },
    { find: '@ow/geom', replacement: r('../../packages/geom/src/index.ts') },
    { find: '@ow/storage', replacement: r('../../packages/storage/src/index.ts') },
    { find: '@ow/commands', replacement: r('../../packages/commands/src/index.ts') },
  ] },
});
