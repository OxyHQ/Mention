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
  vi.stubEnv('INTERNAL_METRICS_TOKEN', '');
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

describe('internal metrics are enabled by holding the token', () => {
  it('is disabled when there is no token', async () => {
    const config = await loadConfig();

    expect(config.internalMetrics.enabled).toBe(false);
  });

  it('is enabled by the token alone, with no flag beside it', async () => {
    /**
     * The route answers 404 without a token anyway, so a separate flag could
     * only ever disagree with reality: "on" while the endpoint stayed shut, or
     * "off" while a token sat there doing nothing.
     */
    const config = await loadConfig({ INTERNAL_METRICS_TOKEN: 'a'.repeat(32) });

    expect(config.internalMetrics.enabled).toBe(true);
    expect(config.internalMetrics.token).toBe('a'.repeat(32));
  });

  it('does not read INTERNAL_METRICS_ENABLED at all', async () => {
    // Setting the retired flag must change nothing — otherwise it is still a
    // switch, just an undocumented one.
    const config = await loadConfig({ INTERNAL_METRICS_ENABLED: 'true' });

    expect(config.internalMetrics.enabled).toBe(false);
  });
});
