import { afterEach, describe, expect, it } from 'vitest';
import {
  getIpHashSalt,
  getMcpJwtSecret,
  getMentionSigningConfig,
  isRedisRuntimeConfigured,
  parseRuntimeEnvironment,
} from '../config';

const originalMcpSecret = process.env.MENTION_MCP_JWT_SECRET;

afterEach(() => {
  if (originalMcpSecret === undefined) {
    delete process.env.MENTION_MCP_JWT_SECRET;
  } else {
    process.env.MENTION_MCP_JWT_SECRET = originalMcpSecret;
  }
});

describe('runtime configuration', () => {
  it('normalizes origins and validates structured lists', () => {
    const parsed = parseRuntimeEnvironment({
      MENTION_PUBLIC_API_URL: 'https://api.example.test///',
      FEDERATION_BLOCKED_DOMAINS: 'spam.example, abuse.example',
      MCP_OAUTH_REDIRECT_URIS_CLAUDE:
        'https://client.example/callback,https://client2.example/callback',
    });

    expect(parsed.MENTION_PUBLIC_API_URL).toBe('https://api.example.test');
    expect(parsed.FEDERATION_BLOCKED_DOMAINS).toEqual([
      'spam.example',
      'abuse.example',
    ]);
    expect(parsed.MCP_OAUTH_REDIRECT_URIS_CLAUDE).toEqual([
      'https://client.example/callback',
      'https://client2.example/callback',
    ]);
  });

  it.each([
    [{ REDIS_PORT: 'not-a-number' }, 'REDIS_PORT'],
    [{ FEDERATION_ENABLED: 'yes' }, 'FEDERATION_ENABLED'],
    [{ REDIS_URL: 'https://redis.example' }, 'REDIS_URL'],
    [{ MENTION_PUBLIC_API_URL: 'https://api.example/path' }, 'MENTION_PUBLIC_API_URL'],
    [{ FEDERATION_BLOCKED_DOMAINS: 'valid.example,https://invalid.example' }, 'FEDERATION_BLOCKED_DOMAINS'],
    [{ FOR_YOU_DISCOVERY_GATE: 'lowEffortGate,unknownGate' }, 'FOR_YOU_DISCOVERY_GATE'],
  ])('rejects a malformed supplied value: %o', (source, expectedField) => {
    expect(() => parseRuntimeEnvironment(source)).toThrow(expectedField);
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
    expect(() =>
      parseRuntimeEnvironment({ OXY_SERVICE_API_KEY: 'service-key' }),
    ).toThrow('OXY_SERVICE_API_SECRET');
    expect(() =>
      parseRuntimeEnvironment({
        FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from('{}').toString('base64'),
      }),
    ).toThrow('FIREBASE_PROJECT_ID');
    expect(() =>
      parseRuntimeEnvironment({
        MENTION_DID: 'did:web:mention.example',
        MENTION_PUBLIC_KEY: 'public-key',
      }),
    ).toThrow('MENTION_DID');
  });

  it('detects every supported explicit Redis target', () => {
    expect(isRedisRuntimeConfigured({})).toBe(false);
    expect(isRedisRuntimeConfigured({ REDIS_URL: 'redis://localhost:6379' })).toBe(true);
    expect(isRedisRuntimeConfigured({ REDIS_URI: 'rediss://cache.example:6380' })).toBe(true);
    expect(isRedisRuntimeConfigured({ REDIS_HOST: 'cache.internal' })).toBe(true);
  });

  it('resolves the MCP secret at call time and rejects weak/unset values', () => {
    delete process.env.MENTION_MCP_JWT_SECRET;
    expect(() => getMcpJwtSecret()).toThrow('not configured');

    process.env.MENTION_MCP_JWT_SECRET = 'short';
    expect(() => getMcpJwtSecret()).toThrow();

    process.env.MENTION_MCP_JWT_SECRET = 'x'.repeat(32);
    expect(getMcpJwtSecret()).toBe('x'.repeat(32));
  });

  it('prefers a dedicated IP salt and safely falls back to the required MCP key', () => {
    expect(
      getIpHashSalt({
        IP_HASH_SALT: 'dedicated-ip-salt',
        MENTION_MCP_JWT_SECRET: 'm'.repeat(32),
      }),
    ).toBe('dedicated-ip-salt');
    expect(
      getIpHashSalt({ MENTION_MCP_JWT_SECRET: 'm'.repeat(32) }),
    ).toBe('m'.repeat(32));
  });

  it('keeps dynamic MTN signing disabled when a rotated key group is incomplete', () => {
    expect(
      getMentionSigningConfig({
        MENTION_DID: 'did:web:mention.example',
        MENTION_PRIVATE_KEY: 'private-only',
      }),
    ).toBeUndefined();
  });
});
