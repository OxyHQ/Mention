import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
  getProfileByUsername: vi.fn(),
  redisGet: vi.fn(),
  redisSetEx: vi.fn(),
  redisDel: vi.fn(),
  isNotFoundError: vi.fn(),
}));

// `fediverseSharing.ts` resolves Oxy through `getServiceOxyClient()` (the
// service-authed client), NOT the bare server `oxy` singleton. Mock that helper
// to control the user/profile lookups the consent reads depend on.
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUserById: mocks.getUserById,
    getProfileByUsername: mocks.getProfileByUsername,
  }),
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
  getFediverseSharingStateById,
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

  describe('isFediverseSharingEnabledFromUser — pure, synchronous, no Redis write', () => {
    it('reads the flag off the given user object without any Oxy call', () => {
      expect(isFediverseSharingEnabledFromUser({ _id: 'u1', fediverseSharing: false })).toBe(false);
      expect(mocks.getUserById).not.toHaveBeenCalled();
      expect(mocks.getProfileByUsername).not.toHaveBeenCalled();
    });

    it('defaults to true when the object omits the field', () => {
      expect(isFediverseSharingEnabledFromUser({ _id: 'u1' })).toBe(true);
    });

    it('defaults to true for a null/undefined user', () => {
      expect(isFediverseSharingEnabledFromUser(null)).toBe(true);
      expect(isFediverseSharingEnabledFromUser(undefined)).toBe(true);
    });

    it('is synchronous — returns a plain boolean, not a Promise', () => {
      const result = isFediverseSharingEnabledFromUser({ _id: 'u1', fediverseSharing: true });
      expect(result).toBe(true);
      expect(result).not.toBeInstanceOf(Promise);
    });

    it('NEVER writes to Redis — the object may be a stale SDK-cached DTO, so seeding would risk overwriting a just-invalidated flag fleet-wide', () => {
      isFediverseSharingEnabledFromUser({ _id: 'u1', fediverseSharing: false });
      expect(mocks.redisSetEx).not.toHaveBeenCalled();
    });

    it('still never writes to Redis for an enabled user with an id', () => {
      isFediverseSharingEnabledFromUser({ _id: 'u1', fediverseSharing: true });
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

  describe('getFediverseSharingStateById', () => {
    it('"enabled" when the DTO says true (or omits the field)', async () => {
      mocks.getUserById.mockResolvedValue({ id: 'u1', fediverseSharing: true });
      expect(await getFediverseSharingStateById('u1')).toBe('enabled');
    });

    it('"disabled" when the DTO explicitly says false', async () => {
      mocks.getUserById.mockResolvedValue({ id: 'u1', fediverseSharing: false });
      expect(await getFediverseSharingStateById('u1')).toBe('disabled');
    });

    it('calls Oxy directly with { cache: false } — bypasses both Redis and the SDK cache', async () => {
      mocks.getUserById.mockResolvedValue({ id: 'u1', fediverseSharing: true });
      await getFediverseSharingStateById('u1');
      expect(mocks.getUserById).toHaveBeenCalledWith('u1', { cache: false });
      expect(mocks.redisGet).not.toHaveBeenCalled();
    });

    it('"unknown-user" when Oxy throws a 404', async () => {
      mocks.isNotFoundError.mockReturnValue(true);
      mocks.getUserById.mockRejectedValue(new Error('not found'));
      expect(await getFediverseSharingStateById('u1')).toBe('unknown-user');
    });

    it('"unavailable" when Oxy throws a non-404 error (outage), logged at warn, never cached', async () => {
      mocks.isNotFoundError.mockReturnValue(false);
      mocks.getUserById.mockRejectedValue(new Error('timeout'));
      expect(await getFediverseSharingStateById('u1')).toBe('unavailable');
      expect(mocks.redisSetEx).not.toHaveBeenCalled();
    });

    it('caches the resolved flag on a successful fresh read', async () => {
      mocks.getUserById.mockResolvedValue({ id: 'u1', fediverseSharing: false });
      await getFediverseSharingStateById('u1');
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
