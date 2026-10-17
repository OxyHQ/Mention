import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Defaults a deployment does not have to restate.
 *
 * Every variable below was carried on the live task definition with the value
 * the code should have had in the first place, which costs twice: a line in
 * every deployment that says nothing, and a default that no deployment has ever
 * run — so nobody would notice if it broke.
 *
 * These assert the RESOLVED config rather than re-deriving it from
 * `process.env`, because re-deriving restates the implementation and passes
 * whatever the config does. Each one loads a fresh module graph, since `config`
 * reads the environment once at import.
 */

async function loadConfig(environment: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [name, value] of Object.entries(environment)) {
    vi.stubEnv(name, value ?? '');
  }
  return (await import('../../config')).config;
}

beforeEach(() => {
  // A deployment sets these; an unset run is what the defaults are for.
  vi.stubEnv('ATPROTO_ENABLED', '');
  vi.stubEnv('FEDERATION_MEDIA_CACHE_WRITE_ENABLED', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('flags that are on unless someone closes them', () => {
  it('reads atproto discovery as enabled with nothing set', async () => {
    const config = await loadConfig();

    expect(config.atproto.enabled).toBe(true);
    // The bridge is the one that writes, and it stays closed.
    expect(config.atproto.bridgeEnabled).toBe(false);
  });

  it('still closes atproto when a deployment says so', async () => {
    const config = await loadConfig({ ATPROTO_ENABLED: 'false' });

    expect(config.atproto.enabled).toBe(false);
  });

  it('reads the federation media cache write side as enabled with nothing set', async () => {
    const config = await loadConfig();

    expect(config.federation.mediaCacheWriteEnabled).toBe(true);
  });

  it('still closes the media cache write side when a deployment says so', async () => {
    const config = await loadConfig({ FEDERATION_MEDIA_CACHE_WRITE_ENABLED: 'false' });

    expect(config.federation.mediaCacheWriteEnabled).toBe(false);
  });
});
