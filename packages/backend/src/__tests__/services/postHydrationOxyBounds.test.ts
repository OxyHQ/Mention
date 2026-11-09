import { lookupManyOf } from '../helpers/oxyLookup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cacheGet, cacheSet, getUsersByIds, getUserById, federatedActorFind } = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  getUsersByIds: vi.fn(),
  getUserById: vi.fn(),
  federatedActorFind: vi.fn(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    users: { get: (...args: unknown[]) => getUserById(...args) },
    follows: {
      following: vi.fn(async () => []),
      followers: vi.fn(async () => []),
    },
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    users: {
      getMany: (...args: unknown[]) => getUsersByIds(...args),
      lookupMany: lookupManyOf((ids: string[]) => getUsersByIds(ids)),
    },
    assets: { publicUrl: (id: string) => id },
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

import {
  OXY_USER_FALLBACK_CONCURRENCY,
  OXY_USER_FAILURE_TTL_MS,
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

  it('maps authoritative redirected ids in one bulk fetch without per-id fallbacks', async () => {
    getUsersByIds.mockResolvedValue([
      { ...oxyUser('canonical'), redirectedUserIds: ['legacy-a', 'legacy-b'] },
    ]);
    const result = await resolveUserSummaries(['legacy-a', 'legacy-b', 'canonical']);
    expect(result.get('legacy-a')?.user.id).toBe('canonical');
    expect(result.get('legacy-b')?.user.id).toBe('canonical');
    expect(getUserById).not.toHaveBeenCalled();
    expect(getUsersByIds).toHaveBeenCalledTimes(1);
  });

  it('does not fan out an overloaded bulk read, and answers its failures from memory briefly', async () => {
    vi.useFakeTimers();
    const ids = ['shed-a', 'shed-b', 'shed-c'];
    getUsersByIds.mockRejectedValue(Object.assign(new Error('Too Many Requests'), { status: 429 }));

    const first = await resolveUserSummaries(ids);
    expect(getUsersByIds).toHaveBeenCalledTimes(1);
    expect(getUserById).not.toHaveBeenCalled();
    expect(first.get('shed-a')?.user.username).toBe('');

    // The next renders inside the window do not ask Oxy again.
    const again = await resolveUserSummaries(ids);
    expect(getUsersByIds).toHaveBeenCalledTimes(1);
    expect(again.get('shed-b')?.user.username).toBe('');
    expect(cacheSet).not.toHaveBeenCalled();

    vi.advanceTimersByTime(OXY_USER_FAILURE_TTL_MS);
    getUsersByIds.mockResolvedValue(ids.map(oxyUser));
    const recovered = await resolveUserSummaries(ids);
    expect(getUsersByIds).toHaveBeenCalledTimes(2);
    expect(recovered.get('shed-c')?.user.username).toBe('user-shed-c');
  });

  it('answers an account Oxy has no record of with the placeholder, without asking again one by one', async () => {
    getUsersByIds.mockResolvedValue([oxyUser('present')]);

    const first = await resolveUserSummaries(['present', 'gone']);

    expect(first.get('present')?.user.username).not.toBe('');
    expect(first.get('gone')?.user.username).toBe('');
    // Absence is the server's answer: no per-id read, and none on the next render.
    expect(getUserById).not.toHaveBeenCalled();
    getUsersByIds.mockClear();
    await resolveUserSummaries(['gone']);
    expect(getUsersByIds).not.toHaveBeenCalled();
  });

  it('limits the public per-id fallback to eight concurrent requests', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `bounded-${index}`);
    let active = 0;
    let peak = 0;
    getUsersByIds.mockRejectedValue(new Error('chunk could not be asked'));
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

  it('keeps the authors of a chunk Oxy answered when another chunk runs past the deadline', async () => {
    vi.useFakeTimers();
    const answered = Array.from({ length: 100 }, (_, i) => `answered-${i}`);
    const slow = Array.from({ length: 50 }, (_, i) => `slow-${i}`);
    // The slow chunk's permit stays held until the test releases it, as a real
    // non-abortable request would: a permit is never left behind for later tests.
    let releaseSlow!: () => void;
    getUsersByIds.mockImplementation(async (ids: string[]) =>
      ids[0]?.startsWith('answered-')
        ? ids.map(oxyUser)
        : new Promise((resolve) => {
            releaseSlow = () => resolve([]);
          }),
    );

    try {
      const pending = resolveUserSummaries([...answered, ...slow]);
      await vi.advanceTimersByTimeAsync(OXY_USER_RESOLUTION_DEADLINE_MS);
      const result = await pending;

      expect(result.get('answered-0')?.user).toMatchObject({ username: 'user-answered-0' });
      expect(result.get('answered-99')?.user).toMatchObject({ username: 'user-answered-99' });
      expect(result.get('slow-0')?.user).toMatchObject({
        username: '',
        name: { displayName: 'Unknown user' },
      });
    } finally {
      releaseSlow();
      await vi.advanceTimersByTimeAsync(0);
      getUsersByIds.mockReset();
    }
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

  it('shares overlapping author reads but returns only the requested identities', async () => {
    let releaseBulk = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseBulk = resolve;
    });
    getUsersByIds.mockImplementation(async (ids: string[]) => {
      await gate;
      return ids.map(oxyUser);
    });
    const first = resolveUserSummaries(['overlap-a', 'overlap-b']);
    const second = resolveUserSummaries(['overlap-b', 'overlap-c']);
    const third = resolveUserSummaries(['overlap-b']);
    await Promise.resolve();
    await Promise.resolve();
    releaseBulk();
    const results = await Promise.all([first, second, third]);

    expect(getUsersByIds.mock.calls.flatMap(([ids]) => ids).sort()).toEqual([
      'overlap-a',
      'overlap-b',
      'overlap-c',
    ]);
    expect(results.map((result) => [...result.keys()].sort())).toEqual([
      ['overlap-a', 'overlap-b'],
      ['overlap-b', 'overlap-c'],
      ['overlap-b'],
    ]);
    // The mocked persistent cache remains cold: completed flights must be released.
    await resolveUserSummaries(['overlap-b']);
    expect(getUsersByIds).toHaveBeenLastCalledWith(['overlap-b']);
    expect(getUsersByIds).toHaveBeenCalledTimes(3);
  });

  it('bounds non-abortable fallback I/O globally across distinct cohorts', async () => {
    vi.useFakeTimers();
    getUsersByIds.mockRejectedValue(new Error('chunk could not be asked'));
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
      resolveUserSummaries(Array.from({ length: 10 }, (_, index) => `global-${cohort}-${index}`)),
    );
    // Let every cohort's bulk read fail and its fallbacks queue before time moves.
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(OXY_USER_RESOLUTION_DEADLINE_MS);
    const results = await Promise.all(cohorts);

    expect(getUserById).toHaveBeenCalledTimes(OXY_USER_FALLBACK_CONCURRENCY);
    expect(peak).toBe(OXY_USER_FALLBACK_CONCURRENCY);
    expect(results.every((result) => result.size === 10)).toBe(true);

    for (const release of releaseCalls) release();
    await Promise.resolve();
  });
});
