import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  redisGet: vi.fn(),
  redisSetEx: vi.fn(),
}));

// Override the global setup.ts redis mock with a ready, in-memory-backed client
// so the blocklist read/write path is actually exercised.
vi.mock('../../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: true,
    isOpen: true,
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    get: mocks.redisGet,
    setEx: mocks.redisSetEx,
  }),
}));

import { revokeJti, isRevoked } from '../../mcp/services/mcpRevocationService';

describe('mcpRevocationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    mocks.redisSetEx.mockImplementation(async (key: string, _ttl: number, value: string) => {
      mocks.store.set(key, value);
      return 'OK';
    });
    mocks.redisGet.mockImplementation(async (key: string) => mocks.store.get(key) ?? null);
  });

  it('writes the blocklist entry under mcp:revoked:<jti> with a TTL', async () => {
    await revokeJti('jti-1');
    expect(mocks.redisSetEx).toHaveBeenCalledWith('mcp:revoked:jti-1', expect.any(Number), '1');
    const [, ttl] = mocks.redisSetEx.mock.calls[0];
    expect(ttl).toBeGreaterThan(0);
  });

  it('isRevoked returns true after revokeJti', async () => {
    await revokeJti('jti-2');
    expect(await isRevoked('jti-2')).toBe(true);
  });

  it('isRevoked returns false for an unknown jti', async () => {
    expect(await isRevoked('never-revoked')).toBe(false);
  });

  it('no-ops on an empty jti (no read/write)', async () => {
    await revokeJti('');
    expect(mocks.redisSetEx).not.toHaveBeenCalled();
    expect(await isRevoked('')).toBe(false);
    expect(mocks.redisGet).not.toHaveBeenCalled();
  });
});
