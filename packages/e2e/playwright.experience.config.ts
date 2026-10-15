import { defineConfig } from '@playwright/test';

/** Actual production app bundles, with deterministic Oxy/Clarity network fixtures. */
export default defineConfig({
  testDir: './experience',
  testMatch: '**/*.spec.mjs',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    actionTimeout: 15_000,
    viewport: { width: 1280, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
