import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * CORS allowlist (`utils/allowedOrigins.ts`). mention.org is the same web app as
 * mention.earth on a second host, so in production it calls the API with the same
 * credentials: it must be allowed exactly like FRONTEND_URL, and nothing else
 * that resembles it may be.
 */
async function loadFor(isProduction: boolean) {
  vi.resetModules();
  vi.doMock('../../config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../config')>();
    return {
      ...actual,
      config: {
        ...actual.config,
        frontendUrl: 'https://mention.earth',
        runtime: { ...actual.config.runtime, isProduction },
      },
    };
  });
  return import('../../utils/allowedOrigins');
}

afterEach(() => {
  vi.doUnmock('../../config');
  vi.resetModules();
});

describe('isAllowedOrigin', () => {
  it('allows the frontend and every web alias origin in production', async () => {
    const { config } = await import('../../config');
    // The default the production task runs with (no env var set).
    expect(config.web.aliasOrigins).toEqual(['https://mention.org']);

    const { isAllowedOrigin } = await loadFor(true);
    expect(isAllowedOrigin('https://mention.earth')).toBe(true);
    expect(isAllowedOrigin('https://mention.org')).toBe(true);
  });

  it('refuses look-alikes of the alias and every development origin in production', async () => {
    const { isAllowedOrigin } = await loadFor(true);
    for (const origin of [
      'http://mention.org',
      'https://www.mention.org',
      'https://api.mention.org',
      'https://mention.org.evil.example',
      'https://mention.org:8443',
      'http://localhost:8110',
    ]) {
      expect(isAllowedOrigin(origin)).toBe(false);
    }
  });

  it('keeps the alias allowed outside production too', async () => {
    const { isAllowedOrigin } = await loadFor(false);
    expect(isAllowedOrigin('https://mention.org')).toBe(true);
    expect(isAllowedOrigin('http://localhost:8110')).toBe(true);
  });
});
