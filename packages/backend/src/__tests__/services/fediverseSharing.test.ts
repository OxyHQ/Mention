import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getProfileByUsername: vi.fn(),
  redisGet: vi.fn(),
  redisSetEx: vi.fn(),
  redisDel: vi.fn(),
  isNotFoundError: vi.fn(),
}));

// `fediverseSharing.ts` reaches `oxy` via a dynamic `import('../../server')`
// inside each function (mirrors the late `require` behind `resolveOxyUser` in
// `connectors/activitypub/constants.ts`) so it never forces the whole server
// entry point into the module graph. `vi.mock` intercepts by resolved path,
// so mocking here reaches that same dynamic import.
vi.mock('../../../server', () => ({
  oxy: { getUserById: mocks.getUserById, getProfileByUsername: mocks.getProfileByUsername },
}));

vi.mock('@oxyhq/core', () => ({
  isNotFoundError: (...args: unknown[]) => mocks.isNotFoundError(...args),
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
  isFediverseSharingEnabledFromUser,
  getFediverseSharingStateByUsername,
  invalidateFediverseSharing,
} from '../../services/fediverseSharing';

describe('fediverseSharing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSetEx.mockResolvedValue('OK');
    mocks.redisDel.mockResolvedValue(1);
    mocks.isNotFoundError.mockReturnValue(false);
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

    it('bypasses the Redis cache with skipRedisCache — a cache hit is ignored and Oxy is queried', async () => {
      mocks.redisGet.mockResolvedValue('1');
      mocks.getUserById.mockResolvedValue({ id: 'u1', fediverseSharing: false });

      expect(await isFediverseSharingEnabled('u1', { skipRedisCache: true })).toBe(false);
      expect(mocks.redisGet).not.toHaveBeenCalled();
      expect(mocks.getUserById).toHaveBeenCalledWith('u1', { cache: false });
      // The fresh resolve still repopulates Redis with the correct value.
      expect(mocks.redisSetEx).toHaveBeenCalledWith('fedisharing:v1:u1', 600, '0');
    });

    it('bypasses the SDK\'s own in-process cache on every Oxy call ({ cache: false })', async () => {
      mocks.getUserById.mockResolvedValue({ id: 'u1', fediverseSharing: true });
      await isFediverseSharingEnabled('u1');
      expect(mocks.getUserById).toHaveBeenCalledWith('u1', { cache: false });
    });
  });

  describe('isFediverseSharingEnabledFromUser', () => {
    it('reads the flag off the given user object without any Oxy call', async () => {
      expect(await isFediverseSharingEnabledFromUser({ _id: 'u1', fediverseSharing: false })).toBe(false);
      expect(mocks.getUserById).not.toHaveBeenCalled();
      expect(mocks.getProfileByUsername).not.toHaveBeenCalled();
    });

    it('defaults to true when the object omits the field', async () => {
      expect(await isFediverseSharingEnabledFromUser({ _id: 'u1' })).toBe(true);
    });

    it('defaults to true for a null/undefined user', async () => {
      expect(await isFediverseSharingEnabledFromUser(null)).toBe(true);
      expect(await isFediverseSharingEnabledFromUser(undefined)).toBe(true);
    });

    it('seeds the id-keyed Redis cache from the given object', async () => {
      await isFediverseSharingEnabledFromUser({ _id: 'u1', fediverseSharing: false });
      expect(mocks.redisSetEx).toHaveBeenCalledWith('fedisharing:v1:u1', 600, '0');
    });

    it('does not touch Redis when the object carries no id', async () => {
      await isFediverseSharingEnabledFromUser({ fediverseSharing: false });
      expect(mocks.redisSetEx).not.toHaveBeenCalled();
    });
  });

  describe('getFediverseSharingStateByUsername', () => {
    it('"enabled" when the DTO says true (or omits the field)', async () => {
      mocks.getProfileByUsername.mockResolvedValue({ _id: 'u1', fediverseSharing: true });
      expect(await getFediverseSharingStateByUsername('alice')).toBe('enabled');
    });

    it('"disabled" when the DTO explicitly says false', async () => {
      mocks.getProfileByUsername.mockResolvedValue({ _id: 'u1', fediverseSharing: false });
      expect(await getFediverseSharingStateByUsername('alice')).toBe('disabled');
    });

    it('calls Oxy directly with { cache: false } — never through the cached resolveOxyUser path', async () => {
      mocks.getProfileByUsername.mockResolvedValue({ _id: 'u1', fediverseSharing: true });
      await getFediverseSharingStateByUsername('alice');
      expect(mocks.getProfileByUsername).toHaveBeenCalledWith('alice', { cache: false });
    });

    it('"unknown-user" when Oxy throws a 404', async () => {
      mocks.isNotFoundError.mockReturnValue(true);
      mocks.getProfileByUsername.mockRejectedValue(new Error('not found'));
      expect(await getFediverseSharingStateByUsername('ghost')).toBe('unknown-user');
    });

    it('"unavailable" when Oxy throws a non-404 error (outage), logged at warn, never cached', async () => {
      mocks.isNotFoundError.mockReturnValue(false);
      mocks.getProfileByUsername.mockRejectedValue(new Error('timeout'));
      expect(await getFediverseSharingStateByUsername('alice')).toBe('unavailable');
      expect(mocks.redisSetEx).not.toHaveBeenCalled();
    });

    it('seeds the id-keyed cache from the resolved DTO', async () => {
      mocks.getProfileByUsername.mockResolvedValue({ _id: 'u1', fediverseSharing: false });
      await getFediverseSharingStateByUsername('alice');
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
