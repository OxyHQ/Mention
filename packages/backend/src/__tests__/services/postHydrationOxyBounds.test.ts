import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  cacheGet,
  cacheSet,
  getUsersByIds,
  getUserById,
  federatedActorFind,
} = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  getUsersByIds: vi.fn(),
  getUserById: vi.fn(),
  federatedActorFind: vi.fn(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById: (...args: unknown[]) => getUserById(...args),
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds: (...args: unknown[]) => getUsersByIds(...args),
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => id,
  }),
}));

vi.mock('../../services/userSummaryCache', () => ({
  mget: (...args: unknown[]) => cacheGet(...args),
  mset: (...args: unknown[]) => cacheSet(...args),
  invalidate: vi.fn(async () => undefined),
}));

vi.mock('../../services/PostRecentReplierService', () => ({
  loadRecentReplierIds: vi.fn(async () => ({
    perPostRepliers: new Map(),
    allReplierIds: new Set(),
  })),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

function chainable(rows: unknown[]) {
  const query: Record<string, unknown> = {};
  query.select = () => query;
  query.lean = async () => rows;
  return query;
}

vi.mock('../../models/Post', () => ({
  Post: { find: () => chainable([]), findOne: () => chainable([]) },
}));
vi.mock('../../models/Poll', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Like', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Bookmark', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/UserSettings', () => ({
  UserSettings: { find: () => chainable([]), findOne: () => chainable([]) },
}));
vi.mock('../../models/StarterPack', () => ({
  StarterPack: { aggregate: async () => [] },
  default: { aggregate: async () => [] },
}));
vi.mock('../../models/FederatedActor', () => ({
  FederatedActor: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => federatedActorFind(...args) }),
    }),
  },
  default: {
    find: (...args: unknown[]) => ({
      select: () => ({ lean: () => federatedActorFind(...args) }),
    }),
  },
}));

import {
  OXY_USER_FALLBACK_CONCURRENCY,
  OXY_USER_RESOLUTION_DEADLINE_MS,
  resolveUserSummaries,
} from '../../services/PostHydrationService';

function oxyUser(id: string) {
  return {
    id,
    username: `user-${id}`,
    name: { displayName: `User ${id}` },
    avatar: null,
  };
}

describe('resolveUserSummaries Oxy bounds', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    cacheGet.mockResolvedValue(new Map());
    cacheSet.mockResolvedValue(undefined);
    federatedActorFind.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the bulk service call without per-id fan-out when it resolves every id', async () => {
    const ids = ['bulk-a', 'bulk-b'];
    getUsersByIds.mockResolvedValue(ids.map(oxyUser));

    const result = await resolveUserSummaries(ids);

    expect(getUsersByIds).toHaveBeenCalledWith(ids);
    expect(getUserById).not.toHaveBeenCalled();
    expect(result.get('bulk-a')?.user.username).toBe('user-bulk-a');
  });

  it('limits the public per-id fallback to eight concurrent requests', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `bounded-${index}`);
    let active = 0;
    let peak = 0;
    getUsersByIds.mockResolvedValue([]);
    getUserById.mockImplementation(async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return oxyUser(id);
    });

    const result = await resolveUserSummaries(ids);

    expect(getUserById).toHaveBeenCalledTimes(ids.length);
    expect(peak).toBe(OXY_USER_FALLBACK_CONCURRENCY);
    expect(result.size).toBe(ids.length);
  });

  it('shares one deadline across bulk and fallback and keeps the ghost-handle fallback', async () => {
    vi.useFakeTimers();
    let releaseBulk!: (users: ReturnType<typeof oxyUser>[]) => void;
    getUsersByIds.mockReturnValue(
      new Promise((resolve) => {
        releaseBulk = resolve;
      }),
    );

    const pending = resolveUserSummaries(['deadline-user']);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(OXY_USER_RESOLUTION_DEADLINE_MS);
    const result = await pending;

    expect(getUserById).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
    expect(result.get('deadline-user')?.user).toMatchObject({
      username: '',
      name: { displayName: 'Unknown user' },
    });
    releaseBulk([]);
    await Promise.resolve();
  });

  it('does not restart the deadline when a slow bulk failure enters per-id fallback', async () => {
    vi.useFakeTimers();
    getUsersByIds.mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('bulk failed late')), 1_000);
        }),
    );
    let releaseFallback!: (user: ReturnType<typeof oxyUser>) => void;
    getUserById.mockReturnValue(
      new Promise((resolve) => {
        releaseFallback = resolve;
      }),
    );

    const startedAt = Date.now();
    let settled = false;
    const pending = resolveUserSummaries(['shared-budget-user']).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(OXY_USER_RESOLUTION_DEADLINE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(Date.now() - startedAt).toBe(OXY_USER_RESOLUTION_DEADLINE_MS);
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(result.get('shared-budget-user')?.user.username).toBe('');
    releaseFallback(oxyUser('shared-budget-user'));
    await Promise.resolve();
  });

  it('single-flights concurrent identical miss cohorts', async () => {
    let releaseBulk!: (users: ReturnType<typeof oxyUser>[]) => void;
    getUsersByIds.mockReturnValue(
      new Promise((resolve) => {
        releaseBulk = resolve;
      }),
    );

    const first = resolveUserSummaries(['flight-b', 'flight-a']);
    const second = resolveUserSummaries(['flight-a', 'flight-b']);
    await Promise.resolve();
    await Promise.resolve();
    releaseBulk([oxyUser('flight-a'), oxyUser('flight-b')]);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(getUsersByIds).toHaveBeenCalledTimes(1);
    expect(firstResult.get('flight-a')?.user.username).toBe('user-flight-a');
    expect(secondResult.get('flight-b')?.user.username).toBe('user-flight-b');
  });

  it('bounds non-abortable fallback I/O globally across distinct cohorts', async () => {
    vi.useFakeTimers();
    getUsersByIds.mockResolvedValue([]);
    const releaseCalls: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    getUserById.mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          releaseCalls.push(() => {
            active -= 1;
            resolve(oxyUser(id));
          });
        }),
    );

    const cohorts = Array.from({ length: 4 }, (_, cohort) =>
      resolveUserSummaries(
        Array.from({ length: 10 }, (_, index) => `global-${cohort}-${index}`),
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(OXY_USER_RESOLUTION_DEADLINE_MS);
    const results = await Promise.all(cohorts);

    expect(getUserById).toHaveBeenCalledTimes(OXY_USER_FALLBACK_CONCURRENCY);
    expect(peak).toBe(OXY_USER_FALLBACK_CONCURRENCY);
    expect(results.every((result) => result.size === 10)).toBe(true);

    for (const release of releaseCalls) release();
    await Promise.resolve();
  });
});
