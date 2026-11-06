import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
const r = (p) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  build: {
    target: 'node20',
    lib: { entry: r('./src/preload/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
    rollupOptions: { external: ['electron'] },
  },
});
