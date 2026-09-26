/**
 * Oxy call budget per REQUEST for the viewer's four relation lists.
 *
 * `resolveViewerPrivacyAndGraph` is the seam every non-feed path that hydrates
 * posts goes through (post detail, feed-item detail, and hydration's unthreaded
 * fallback for notifications, search and profile). It resolved blocked,
 * restricted, following and followers from Oxy on EVERY request, and Oxy charges
 * those to the reader's own rate budget — so a reader scrolling exhausted it on
 * their own behalf, and the blocked/restricted half, which fails closed, turned
 * the resulting 429s into 500s.
 *
 * What this pins is the budget across a SEQUENCE of requests, which is where the
 * regression lived: the per-request count was already 4 and looked reasonable.
 * The second request inside the freshness window must cost ZERO, and the counts
 * are asserted as equalities so a failure reports how many calls leaked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

const client = {
  isReady: true,
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  mGet: vi.fn(async (keys: string[]) => keys.map((key) => store.get(key) ?? null)),
  exists: vi.fn(async (key: string) => (store.has(key) ? 1 : 0)),
  setEx: vi.fn(async (key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (keys: string[] | string) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
    return 1;
  }),
  multi: vi.fn(() => ({
    setEx: (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    },
    exec: async () => [],
  })),
};

vi.mock('../../utils/redis', () => ({
  getRedisClient: () => client,
  reportRedisConnectionFailure: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({}),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({}),
}));

import { resolveViewerPrivacyAndGraph, type OxyClient } from '../../utils/privacyHelpers';

const VIEWER = 'budget-viewer';

function spyClient() {
  return {
    privacy: {
      blocked: vi.fn(async (): Promise<unknown[]> => [{ blockedId: 'blocked-1' }]),
      restricted: vi.fn(async (): Promise<unknown[]> => [{ restrictedId: 'restricted-1' }]),
    },
    follows: {
      following: vi.fn(async (): Promise<unknown> => ({ following: [{ id: 'followed-1' }] })),
      followers: vi.fn(async (): Promise<unknown> => ({ followers: [{ id: 'follower-1' }] })),
      viewerGraph: vi.fn(async (): Promise<unknown> => ({})),
    },
  } satisfies OxyClient;
}

function callCounts(oxy: ReturnType<typeof spyClient>): Record<string, number> {
  return {
    blocked: oxy.privacy.blocked.mock.calls.length,
    restricted: oxy.privacy.restricted.mock.calls.length,
    following: oxy.follows.following.mock.calls.length,
    followers: oxy.follows.followers.mock.calls.length,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  client.isReady = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveViewerPrivacyAndGraph', () => {
  it('costs four Oxy calls cold and nothing on the next request', async () => {
    const oxy = spyClient();

    const first = await resolveViewerPrivacyAndGraph(VIEWER, oxy);
    expect(callCounts(oxy)).toEqual({ blocked: 1, restricted: 1, following: 1, followers: 1 });

    const second = await resolveViewerPrivacyAndGraph(VIEWER, oxy);
    expect(callCounts(oxy)).toEqual({ blocked: 1, restricted: 1, following: 1, followers: 1 });

    expect(second).toEqual(first);
    expect(first).toEqual({
      viewerPrivacy: { blockedIds: ['blocked-1'], restrictedIds: ['restricted-1'] },
      viewerGraph: { followingIds: ['followed-1'], followerIds: ['follower-1'] },
    });
  });

  it('refreshes once behind the response after the window, not on every request', async () => {
    const oxy = spyClient();
    await resolveViewerPrivacyAndGraph(VIEWER, oxy);

    vi.setSystemTime(Date.now() + 60 * 1000);
    await resolveViewerPrivacyAndGraph(VIEWER, oxy);
    await resolveViewerPrivacyAndGraph(VIEWER, oxy);
    // Let the background refreshes settle before counting them.
    await Promise.resolve();
    await Promise.resolve();

    // One stale-triggered refresh per list — not one per request.
    expect(callCounts(oxy)).toEqual({ blocked: 2, restricted: 2, following: 2, followers: 2 });
  });

  it('keeps each viewer on their own budget', async () => {
    const mine = spyClient();
    const theirs = spyClient();

    await resolveViewerPrivacyAndGraph(VIEWER, mine);
    await resolveViewerPrivacyAndGraph('other-viewer', theirs);

    expect(callCounts(theirs)).toEqual({ blocked: 1, restricted: 1, following: 1, followers: 1 });
  });

  it('degrades to the caller soft-fail when only the follow half is unavailable', async () => {
    const oxy = spyClient();
    oxy.follows.following.mockRejectedValue(
      Object.assign(new Error('HTTP 429: Too Many Requests'), { status: 429 }),
    );

    const resolved = await resolveViewerPrivacyAndGraph(VIEWER, oxy);

    // The privacy half is authoritative and resolved; the ranking half is empty.
    expect(resolved?.viewerPrivacy).toEqual({
      blockedIds: ['blocked-1'],
      restrictedIds: ['restricted-1'],
    });
    expect(resolved?.viewerGraph.followingIds).toEqual([]);
    expect(resolved?.viewerGraph.followerIds).toEqual(['follower-1']);
  });

  it('still refuses the request when the privacy half is unavailable cold', async () => {
    const oxy = spyClient();
    oxy.privacy.blocked.mockRejectedValue(
      Object.assign(new Error('HTTP 429: Too Many Requests'), { status: 429 }),
    );

    await expect(resolveViewerPrivacyAndGraph(VIEWER, oxy)).rejects.toThrow(
      'Oxy could not resolve the delegated blocked privacy context',
    );
  });

  it('answers from the retained lists when Oxy stops answering entirely', async () => {
    const healthy = spyClient();
    await resolveViewerPrivacyAndGraph(VIEWER, healthy);

    vi.setSystemTime(Date.now() + 60 * 1000);
    const down = spyClient();
    for (const spy of [down.privacy.blocked, down.privacy.restricted, down.follows.following, down.follows.followers]) {
      spy.mockRejectedValue(Object.assign(new Error('HTTP 429: Too Many Requests'), { status: 429 }));
    }

    const served = await resolveViewerPrivacyAndGraph(VIEWER, down);

    expect(served).toEqual({
      viewerPrivacy: { blockedIds: ['blocked-1'], restrictedIds: ['restricted-1'] },
      viewerGraph: { followingIds: ['followed-1'], followerIds: ['follower-1'] },
    });
  });
});
