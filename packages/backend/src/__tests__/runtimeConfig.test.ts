import { describe, expect, it } from 'bun:test';
import {
  getIpHashSalt,
  isRedisRuntimeConfigured,
  isQueueRedisRuntimeConfigured,
  parseRuntimeEnvironment,
} from '../config';

describe('runtime configuration', () => {
  it('keeps combined execution by default and requires Redis when splitting roles', () => {
    expect(parseRuntimeEnvironment({}).MENTION_PROCESS_ROLE).toBe('combined');
    for (const role of ['backend', 'worker']) {
      expect(() => parseRuntimeEnvironment({ MENTION_PROCESS_ROLE: role })).toThrow(
        'MENTION_PROCESS_ROLE',
      );
      expect(
        parseRuntimeEnvironment({ MENTION_PROCESS_ROLE: role, REDIS_URL: 'redis://localhost:6379' })
          .MENTION_PROCESS_ROLE,
      ).toBe(role);
    }
    expect(() => parseRuntimeEnvironment({ MENTION_PROCESS_ROLE: 'unknown' })).toThrow(
      'MENTION_PROCESS_ROLE',
    );
  });

  it('normalizes origins and validates structured lists', () => {
    const parsed = parseRuntimeEnvironment({
      MENTION_PUBLIC_API_URL: 'https://api.example.test///',
      FEDERATION_BLOCKED_DOMAINS: 'spam.example, abuse.example',
    });

    expect(parsed.MENTION_PUBLIC_API_URL).toBe('https://api.example.test');
    expect(parsed.FEDERATION_BLOCKED_DOMAINS).toEqual(['spam.example', 'abuse.example']);
  });

  it.each([
    [{ REDIS_PORT: 'not-a-number' }, 'REDIS_PORT'],
    [{ FEDERATION_ENABLED: 'yes' }, 'FEDERATION_ENABLED'],
    [{ REDIS_URL: 'https://redis.example' }, 'REDIS_URL'],
    [{ MENTION_PUBLIC_API_URL: 'https://api.example/path' }, 'MENTION_PUBLIC_API_URL'],
    [
      { FEDERATION_BLOCKED_DOMAINS: 'valid.example,https://invalid.example' },
      'FEDERATION_BLOCKED_DOMAINS',
    ],
    [{ FOR_YOU_DISCOVERY_GATE: 'lowEffortGate,unknownGate' }, 'FOR_YOU_DISCOVERY_GATE'],
    [{ DISCOVERY_GATE_ROLLOUT: 'maybe' }, 'DISCOVERY_GATE_ROLLOUT'],
  ])('rejects a malformed supplied value: %o', (source, expectedField) => {
    expect(() => parseRuntimeEnvironment(source)).toThrow(expectedField);
  });

  it('serves mention.org as an alias of the public web app and API by default', () => {
    const defaults = parseRuntimeEnvironment({});
    expect(defaults.MENTION_WEB_ORIGIN).toBe('https://mention.earth');
    expect(defaults.MENTION_WEB_ALIAS_ORIGINS).toEqual(['https://mention.org']);
    expect(defaults.MENTION_API_ALIAS_ORIGINS).toEqual(['https://api.mention.org']);
    // Blank is "unset", exactly like every other origin here.
    expect(
      parseRuntimeEnvironment({ MENTION_WEB_ALIAS_ORIGINS: ' ' }).MENTION_WEB_ALIAS_ORIGINS,
    ).toEqual(['https://mention.org']);

    const listed = parseRuntimeEnvironment({
      MENTION_WEB_ALIAS_ORIGINS: 'https://mention.org/, https://social.example.test',
      MENTION_API_ALIAS_ORIGINS: 'NONE',
    });
    expect(listed.MENTION_WEB_ALIAS_ORIGINS).toEqual([
      'https://mention.org',
      'https://social.example.test',
    ]);
    expect(listed.MENTION_API_ALIAS_ORIGINS).toEqual([]);
    expect(
      parseRuntimeEnvironment({ MENTION_WEB_ALIAS_ORIGINS: 'none' }).MENTION_WEB_ALIAS_ORIGINS,
    ).toEqual([]);

    for (const value of [
      'https://mention.org/app',
      'wss://mention.org',
      'https://mention.org,https://user@social.example.test',
    ]) {
      expect(() => parseRuntimeEnvironment({ MENTION_WEB_ALIAS_ORIGINS: value })).toThrow(
        'MENTION_WEB_ALIAS_ORIGINS',
      );
    }
    // Not a URL at all: refused too (by the shared origin schema's URL parse).
    expect(() => parseRuntimeEnvironment({ MENTION_WEB_ALIAS_ORIGINS: 'mention.org' })).toThrow();
  });

  it('leaves the Mercaria origins to the SDK unless an override is supplied', () => {
    const unset = parseRuntimeEnvironment({ MERCARIA_API_URL: '', MERCARIA_WEB_URL: '  ' });
    expect(unset.MERCARIA_API_URL).toBeUndefined();
    expect(unset.MERCARIA_WEB_URL).toBeUndefined();

    const overridden = parseRuntimeEnvironment({
      MERCARIA_API_URL: 'https://mercaria-api.example.test/',
      MERCARIA_WEB_URL: 'http://localhost:8081',
    });
    expect(overridden.MERCARIA_API_URL).toBe('https://mercaria-api.example.test');
    expect(overridden.MERCARIA_WEB_URL).toBe('http://localhost:8081');

    expect(() =>
      parseRuntimeEnvironment({ MERCARIA_API_URL: 'https://mercaria-api.example.test/public/v1' }),
    ).toThrow('MERCARIA_API_URL');
  });

  it('rejects conflicting Redis aliases instead of choosing one silently', () => {
    expect(() =>
      parseRuntimeEnvironment({
        REDIS_URL: 'redis://primary.example:6379',
        REDIS_URI: 'redis://other.example:6379',
      }),
    ).toThrow('REDIS_URI');
  });

  it('rejects partial credential groups', () => {
    expect(() => parseRuntimeEnvironment({ OXY_SERVICE_API_KEY: 'service-key' })).toThrow(
      'Oxy service keys are retired',
    );
    expect(() =>
      parseRuntimeEnvironment({
        FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from('{}').toString('base64'),
      }),
    ).toThrow('FIREBASE_PROJECT_ID');
  });

  it('detects every supported explicit Redis target', () => {
    expect(isRedisRuntimeConfigured({})).toBe(false);
    expect(isRedisRuntimeConfigured({ REDIS_URL: 'redis://localhost:6379' })).toBe(true);
    expect(isRedisRuntimeConfigured({ REDIS_URI: 'rediss://cache.example:6380' })).toBe(true);
    expect(isRedisRuntimeConfigured({ REDIS_HOST: 'cache.internal' })).toBe(true);
  });

  it('gives BullMQ a Redis of its own, or the cache when it has none', () => {
    expect(isQueueRedisRuntimeConfigured({})).toBe(false);
    expect(isQueueRedisRuntimeConfigured({ QUEUE_REDIS_URL: 'redis://queue.internal:6379' })).toBe(
      true,
    );
    expect(isQueueRedisRuntimeConfigured({ REDIS_URL: 'redis://localhost:6379' })).toBe(true);
    expect(() => isQueueRedisRuntimeConfigured({ QUEUE_REDIS_URL: 'http://queue' })).toThrow();
  });

  it('prefers a dedicated IP salt and safely falls back to the former MCP key', () => {
    expect(
      getIpHashSalt({
        IP_HASH_SALT: 'dedicated-ip-salt',
        MENTION_MCP_JWT_SECRET: 'm'.repeat(32),
      }),
    ).toBe('dedicated-ip-salt');
    expect(getIpHashSalt({ MENTION_MCP_JWT_SECRET: 'm'.repeat(32) })).toBe('m'.repeat(32));
  });
});

describe('CLOUDFLARE_PURGE_ZONES', () => {
  const earth = 'e'.repeat(32);
  const org = 'f'.repeat(32);

  it('is unset by default, which keeps the single CLOUDFLARE_ZONE_ID zone', () => {
    expect(parseRuntimeEnvironment({}).CLOUDFLARE_PURGE_ZONES).toBeUndefined();
    expect(parseRuntimeEnvironment({ CLOUDFLARE_PURGE_ZONES: '  ' }).CLOUDFLARE_PURGE_ZONES).toBe(
      undefined,
    );
  });

  it('reads host=zoneId pairs', () => {
    expect(
      parseRuntimeEnvironment({
        CLOUDFLARE_PURGE_ZONES: ` Mention.Earth=${earth} , mention.org=${org},`,
      }).CLOUDFLARE_PURGE_ZONES,
    ).toEqual([
      { host: 'mention.earth', zoneId: earth },
      { host: 'mention.org', zoneId: org },
    ]);
  });

  it.each([
    'mention.earth',
    `mention.earth=${'x'.repeat(32)}`,
    `https://mention.earth=${earth}`,
    `mention.earth=${earth},mention.earth=${org}`,
  ])('rejects %p', (value) => {
    expect(() => parseRuntimeEnvironment({ CLOUDFLARE_PURGE_ZONES: value })).toThrow(
      'CLOUDFLARE_PURGE_ZONES',
    );
  });
});
