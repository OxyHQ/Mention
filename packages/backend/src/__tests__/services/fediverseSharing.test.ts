import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  resolveOxyUser: vi.fn(),
  redisGet: vi.fn(),
  redisSetEx: vi.fn(),
  redisDel: vi.fn(),
}));

// `fediverseSharing.ts` reaches `oxy` via a late `require('../../server.js')`
// (mirrors `resolveOxyUser` in `connectors/activitypub/constants.ts`) so it
// never forces the whole server entry point into the module graph. `vi.mock`
// intercepts by resolved path, so mocking here reaches that same require.
vi.mock('../../../server', () => ({
  oxy: { getUserById: mocks.getUserById },
}));

vi.mock('../../connectors/activitypub/constants', () => ({
  resolveOxyUser: mocks.resolveOxyUser,
}));

vi.mock('../../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: true,
    isOpen: true,
    connect: vi.fn().mockResolvedValue(undefined),
    // `ensureRedisConnected` pings a ready client before running the
    // operation; a healthy client must resolve it or `withRedisFallback`
    // returns the no-op fallback instead of exercising the mocked op.
    ping: vi.fn().mockResolvedValue('PONG'),
    get: mocks.redisGet,
    setEx: mocks.redisSetEx,
    del: mocks.redisDel,
  }),
}));

import {
  isFediverseSharingEnabled,
  isFediverseSharingEnabledByUsername,
  invalidateFediverseSharing,
} from '../../services/fediverseSharing';

describe('fediverseSharing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSetEx.mockResolvedValue('OK');
    mocks.redisDel.mockResolvedValue(1);
  });

  describe('isFediverseSharingEnabled', () => {
    it('true when DTO says true', async () => {
      mocks.getUserById.mockResolvedValue({ id: 'u1', fediverseSharing: true });
      expect(await isFediverseSharingEnabled('u1')).toBe(true);
    });

    it('false when DTO explicitly false', async () => {
      mocks.getUserById.mockResolvedValue({ id: 'u1', fediverseSharing: false });
      expect(await isFediverseSharingEnabled('u1')).toBe(false);
    });

    it('defaults to true when field absent (old DTO)', async () => {
      mocks.getUserById.mockResolvedValue({ id: 'u1' });
      expect(await isFediverseSharingEnabled('u1')).toBe(true);
    });

    it('fails OPEN (true) when oxy lookup throws — availability over privacy for reads; gates 404 on unknown user separately', async () => {
      mocks.getUserById.mockRejectedValue(new Error('down'));
      expect(await isFediverseSharingEnabled('u1')).toBe(true);
      expect(mocks.redisSetEx).not.toHaveBeenCalled();
    });

    it('caches the resolved flag under the documented key + TTL', async () => {
      mocks.getUserById.mockResolvedValue({ id: 'u1', fediverseSharing: false });
      await isFediverseSharingEnabled('u1');
      expect(mocks.redisSetEx).toHaveBeenCalledWith('fedisharing:v1:u1', 600, '0');
    });

    it('short-circuits on a cache hit without calling oxy', async () => {
      mocks.redisGet.mockResolvedValue('0');
      expect(await isFediverseSharingEnabled('u1')).toBe(false);
      expect(mocks.getUserById).not.toHaveBeenCalled();
    });
  });

  describe('isFediverseSharingEnabledByUsername', () => {
    it('returns false for an unknown username', async () => {
      mocks.resolveOxyUser.mockResolvedValue(null);
      expect(await isFediverseSharingEnabledByUsername('ghost')).toBe(false);
    });

    it('reads the flag off the resolved DTO', async () => {
      mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1', username: 'alice', fediverseSharing: false });
      expect(await isFediverseSharingEnabledByUsername('alice')).toBe(false);
    });

    it('defaults to true when the resolved DTO omits the field', async () => {
      mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1', username: 'alice' });
      expect(await isFediverseSharingEnabledByUsername('alice')).toBe(true);
    });

    it('seeds the id-keyed cache from the resolved DTO', async () => {
      mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1', username: 'alice', fediverseSharing: false });
      await isFediverseSharingEnabledByUsername('alice');
      expect(mocks.redisSetEx).toHaveBeenCalledWith('fedisharing:v1:u1', 600, '0');
    });
  });

  describe('invalidateFediverseSharing', () => {
    it('deletes the cache key for the given oxy user id', async () => {
      await invalidateFediverseSharing('u1');
      expect(mocks.redisDel).toHaveBeenCalledWith('fedisharing:v1:u1');
    });
  });
});
