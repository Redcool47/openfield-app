import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ow/geom': r('./packages/geom/src/index.ts'),
      '@ow/model': r('./packages/model/src/index.ts'),
      '@ow/storage': r('./packages/storage/src/index.ts'),
      '@ow/text': r('./packages/text/src/index.ts'),
      '@ow/db-engine': r('./packages/db-engine/src/index.ts'),
      '@ow/formula': r('./packages/formula/src/index.ts'),
      '@ow/storage': r('./packages/storage/src/index.ts'),
      '@ow/formats': r('./packages/formats/src/index.ts'),
      '@ow/commands': r('./packages/commands/src/index.ts'),
      '@ow/automation': r('./packages/automation/src/index.ts'),
      '@ow/ui-kit': r('./packages/ui-kit/src/index.ts'),
    },
  },
  test: {
    globals: true,
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});