import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig(base, {
  testMatch: 'identity-cold-live.spec.ts',
  globalSetup: './coldIdentityPreflight.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  outputDir: 'test-results/identity-cold-live',
  reporter: [['list'], ['json', { outputFile: 'test-results/identity-cold-live/results.json' }]],
  use: {
    trace: 'on', screenshot: 'on', storageState: { cookies: [], origins: [] },
    launchOptions: process.env.MENTION_E2E_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.MENTION_E2E_CHROMIUM_EXECUTABLE } : undefined,
  },
});
