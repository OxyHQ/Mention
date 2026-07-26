import { defineConfig } from 'vitest/config';
import path from 'path';

const backendRoot = path.resolve(__dirname, '.');

export default defineConfig({
  root: backendRoot,
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [path.resolve(backendRoot, 'src/__tests__/setup.ts')],
    include: [path.resolve(backendRoot, 'src/__tests__/**/*.test.ts')],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/scripts/**'],
    },
  },
  resolve: {
    alias: {
      '@mention/shared-types': path.resolve(__dirname, '../shared-types/src'),
      // The backend production build is CommonJS. Resolve the Oxy dual packages
      // to their CJS entrypoints in tests as well; Bun's Vitest runner otherwise
      // selects the ESM build and mis-interops its nested Zod 3 named export.
      '@oxyhq/protocol/node': path.resolve(
        __dirname,
        '../../node_modules/@oxyhq/protocol/dist/cjs/node/index.js',
      ),
      '@oxyhq/protocol': path.resolve(
        __dirname,
        '../../node_modules/@oxyhq/protocol/dist/cjs/index.js',
      ),
      '@oxyhq/contracts': path.resolve(
        __dirname,
        '../../node_modules/@oxyhq/contracts/dist/cjs/index.js',
      ),
    },
  },
});
