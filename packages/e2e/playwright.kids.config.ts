// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { defineConfig } from '@playwright/test';
/** Production bundle and real shared SDK/UI, deterministic HTTP authority fixtures. */
export default defineConfig({
  testDir: './kids',
  workers: 1,
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 } } },
  ],
  retries: 0,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    viewport: { width: 1280, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
