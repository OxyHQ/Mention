// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.stubEnv('OXY_SERVICE_API_KEY', '');
  vi.stubEnv('OXY_SERVICE_API_SECRET', '');
  vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '');
  vi.stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI', '');
  vi.stubEnv('POST_CLASSIFICATION_ENABLED', 'true');
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe('workload provider configuration', () => {
  it('allows lazy local role/SSO resolution without assuming that construction proves identity', async () => {
    const { validateEnvironment } = await import('../../config');
    expect(() => validateEnvironment()).not.toThrow();
  });
  it.each([
    { OXY_SERVICE_API_KEY: 'customer-key' },
    { OXY_SERVICE_API_SECRET: 'customer-secret' },
    { OXY_SERVICE_API_KEY: 'customer-key', OXY_SERVICE_API_SECRET: 'customer-secret' },
  ])('refuses retired customer key fallback %j', async (environment) => {
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
    await expect(import('../../config')).rejects.toThrow(/service keys are retired/);
  });
});
