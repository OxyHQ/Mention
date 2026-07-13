import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * CURATOR FOLLOWER COUNTS — the dedicated resolver behind `curatorAuthority`.
 *
 * The whole reason this module exists is that a COLD curator (one who happens not
 * to be in any cache) must STILL be resolved, so that "a pack owned by someone with
 * a big audience is worth more" actually holds. Reading the count off the shared
 * `usersummary:` identity cache would have been recursive (that cache is filled by
 * the same function that computes curation scores) and would have made a summary's
 * own score depend on cache fill order — so this suite also LOCKS IN that nothing
 * on this path ever touches a `usersummary:` key.
 */

const { getUsersByIds, redisStore, mGet, setEx } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    getUsersByIds: vi.fn(),
    redisStore: store,
    mGet: vi.fn(async (keys: string[]) => keys.map((key) => store.get(key) ?? null)),
    setEx: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
  };
});

// A ready Redis client whose MULTI pipeline writes straight through to the store,
// so a second pass can observe the cache the first pass populated.
vi.mock('../../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: true,
    isOpen: true,
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    mGet,
    multi: () => {
      const queued: Array<() => Promise<void>> = [];
      const pipeline = {
        setEx: (key: string, ttl: number, value: string) => {
          queued.push(() => setEx(key, ttl, value));
          return pipeline;
        },
        exec: async () => {
          for (const write of queued) await write();
        },
      };
      return pipeline;
    },
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ getUsersByIds }),
}));

import { MtnConfig } from '@mention/shared-types';
import { resolveCuratorFollowerCounts } from '../../services/curatorFollowerCounts';
import { computeStarterPackScores, curatorAuthority } from '../../services/starterPackCuration';

const CURATION = MtnConfig.ranking.optInSignals.starterPackBoost;

/** Minimal Oxy user shape the resolver reads: an id and a follower count. */
function oxyUser(id: string, followers: number): Record<string, unknown> {
  return { id, username: id, name: {}, _count: { followers } };
}

/** Every Redis key this path touched, in call order (reads and writes). */
function touchedKeys(): string[] {
  const readKeys = mGet.mock.calls.flatMap(([keys]) => keys as string[]);
  const writeKeys = setEx.mock.calls.map(([key]) => key as string);
  return [...readKeys, ...writeKeys];
}

beforeEach(() => {
  redisStore.clear();
  vi.clearAllMocks();
});

describe('resolveCuratorFollowerCounts', () => {
  it('resolves a COLD curator from Oxy — a big audience still amplifies', async () => {
    getUsersByIds.mockResolvedValue([oxyUser('whale', 100_000)]);

    const counts = await resolveCuratorFollowerCounts(['whale']);

    expect(counts.get('whale')).toBe(100_000);
    // The point of the whole module: a cold curator does NOT collapse to the floor.
    expect(curatorAuthority(counts.get('whale'))).toBeGreaterThan(CURATION.curatorAuthority.min);
  });

  it('issues exactly ONE bulk Oxy call for N curators', async () => {
    const curatorIds = Array.from({ length: 25 }, (_, i) => `curator-${i}`);
    getUsersByIds.mockResolvedValue(curatorIds.map((id, i) => oxyUser(id, i * 10)));

    const counts = await resolveCuratorFollowerCounts(curatorIds);

    expect(counts.size).toBe(curatorIds.length);
    expect(getUsersByIds).toHaveBeenCalledTimes(1);
    expect(getUsersByIds).toHaveBeenCalledWith(curatorIds);
  });

  it('CACHES: a second pass serves from Redis without touching Oxy', async () => {
    getUsersByIds.mockResolvedValue([oxyUser('curator-1', 4_200)]);

    const first = await resolveCuratorFollowerCounts(['curator-1']);
    const second = await resolveCuratorFollowerCounts(['curator-1']);

    expect(first.get('curator-1')).toBe(4_200);
    expect(second.get('curator-1')).toBe(4_200);
    expect(getUsersByIds).toHaveBeenCalledTimes(1);
  });

  it('fetches ONLY the misses when the batch is partially cached', async () => {
    getUsersByIds.mockResolvedValue([oxyUser('warm', 10)]);
    await resolveCuratorFollowerCounts(['warm']);
    getUsersByIds.mockClear();

    getUsersByIds.mockResolvedValue([oxyUser('cold', 20)]);
    const counts = await resolveCuratorFollowerCounts(['warm', 'cold']);

    expect(getUsersByIds).toHaveBeenCalledTimes(1);
    expect(getUsersByIds).toHaveBeenCalledWith(['cold']);
    expect(counts.get('warm')).toBe(10);
    expect(counts.get('cold')).toBe(20);
  });

  it('dedupes ids and short-circuits an empty batch', async () => {
    getUsersByIds.mockResolvedValue([oxyUser('curator-1', 5)]);

    await resolveCuratorFollowerCounts(['curator-1', 'curator-1', '']);
    expect(getUsersByIds).toHaveBeenCalledWith(['curator-1']);

    getUsersByIds.mockClear();
    await expect(resolveCuratorFollowerCounts([])).resolves.toEqual(new Map());
    expect(getUsersByIds).not.toHaveBeenCalled();
  });

  it('is FAIL-SOFT: an Oxy failure yields UNKNOWN counts (neutral authority), never throws', async () => {
    getUsersByIds.mockRejectedValue(new Error('oxy unreachable'));

    const counts = await resolveCuratorFollowerCounts(['curator-1']);

    expect(counts.size).toBe(0);
    expect(curatorAuthority(counts.get('curator-1'))).toBe(CURATION.curatorAuthority.min);
  });

  it('ignores curators Oxy does not return, or whose count is unusable', async () => {
    getUsersByIds.mockResolvedValue([
      oxyUser('good', 7),
      { id: 'no-count', name: {} },
      { id: 'negative', name: {}, _count: { followers: -1 } },
    ]);

    const counts = await resolveCuratorFollowerCounts(['good', 'no-count', 'negative', 'missing']);

    expect(counts.get('good')).toBe(7);
    expect(counts.has('no-count')).toBe(false);
    expect(counts.has('negative')).toBe(false);
    expect(counts.has('missing')).toBe(false);
  });

  it('NEVER touches a `usersummary:` key — its cache is entirely its own', async () => {
    getUsersByIds.mockResolvedValue([oxyUser('curator-1', 9)]);

    await resolveCuratorFollowerCounts(['curator-1']);
    await resolveCuratorFollowerCounts(['curator-1']);

    const keys = touchedKeys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith('curatorfollowers:v1:'))).toBe(true);
    expect(keys.some((key) => key.startsWith('usersummary:'))).toBe(false);
  });

  it('writes with the configured TTL (no magic number)', async () => {
    getUsersByIds.mockResolvedValue([oxyUser('curator-1', 9)]);

    await resolveCuratorFollowerCounts(['curator-1']);

    expect(setEx).toHaveBeenCalledWith(
      'curatorfollowers:v1:curator-1',
      CURATION.curatorAuthority.cacheTtlSeconds,
      '9',
    );
  });
});

describe('starter-pack curation with the real curator resolver', () => {
  const edges = [{ authorId: 'author-1', curatorId: 'whale', useCount: 10 }];
  const deps = {
    loadCurationEdges: vi.fn(async () => edges),
    loadCuratorFollowerCounts: resolveCuratorFollowerCounts,
  };

  beforeEach(() => {
    deps.loadCurationEdges.mockClear();
  });

  it('a COLD, well-followed curator amplifies the score (resolved via Oxy)', async () => {
    getUsersByIds.mockResolvedValue([oxyUser('whale', 100_000)]);
    const amplified = await computeStarterPackScores(['author-1'], deps);

    redisStore.clear();
    getUsersByIds.mockResolvedValue([oxyUser('whale', 0)]);
    const neutral = await computeStarterPackScores(['author-1'], deps);

    expect(amplified.get('author-1') ?? 0).toBeGreaterThan(neutral.get('author-1') ?? 0);
  });

  it('an Oxy outage still scores the author (neutral curator authority), feed unaffected', async () => {
    getUsersByIds.mockRejectedValue(new Error('oxy unreachable'));

    const scores = await computeStarterPackScores(['author-1'], deps);

    expect(scores.get('author-1')).toBeCloseTo(
      Math.log1p(10) * CURATION.curatorAuthority.min,
      10,
    );
  });
});
