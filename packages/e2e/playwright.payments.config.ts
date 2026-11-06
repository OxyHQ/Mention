import { defineConfig } from '@playwright/test';
import { APP_ORIGIN } from './environment';
export default defineConfig({
  testDir: './tests',
  testMatch: 'plus-canonical-checkout.spec.ts',
  workers: 1,
  timeout: 120000,
  use: { baseURL: APP_ORIGIN, headless: true },
  expect: { timeout: 30000 },
});
