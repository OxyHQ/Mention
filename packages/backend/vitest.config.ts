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
    },
  },
});
