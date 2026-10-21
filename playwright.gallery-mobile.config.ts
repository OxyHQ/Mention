import { defineConfig } from '@playwright/test';
import base from './packages/e2e/playwright.config';

export default defineConfig({
  ...base,
  testDir: './packages/e2e/tests',
  globalSetup: './packages/e2e/preflight.ts',
  outputDir: './packages/e2e/test-results-mobile-gallery',
  projects: [{
    name: 'chromium-mobile-viewport',
    use: { viewport: { width: 390, height: 844 }, locale: 'en-US' },
  }],
});
