import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * `loadViewerFeedContext` resolves the viewer's social graph ONCE per feed
 * request. This asserts the Phase-2 invariant for the graph-resolution half:
 * `getUserFollowing` and `getUserFollowers` each hit Oxy AT MOST once, the two
 * run concurrently, the resolved ids land on the context (threaded downstream so
 * hydration never re-fetches them), and each branch soft-fails independently.
 *
 * The models/services the loader touches are mocked so this focuses purely on the
 * graph-resolution contract (no Mongo / no server.ts side effects).
 */

// privacyHelpers (imported by feedContext for the extract* helpers) pulls in the
vi.mock('../runtime/oxyClient', () => ({ getRuntimeOxyClient: () => ({}) }));
vi.mock('../services/ListSubscriptionService', () => ({
  listSubscriptionService: { getSubscribedListMemberIds: vi.fn(async () => []) },
}));
vi.mock('../services/UserPreferenceService', () => ({
  userPreferenceService: { getUserBehavior: vi.fn(async () => undefined), getTopRegion: vi.fn(() => undefined) },
}));

import { randomUUID } from 'node:crypto';

import { loadViewerFeedContext } from '../mtn/feed/feedContext';
import type { OxyClient } from '../utils/privacyHelpers';

/**
 * A viewer id nobody else has used.
 *
 * The graph reads are cached PER VIEWER now (`utils/privacyHelpers`, Redis with
 * stale-while-revalidate), so a fixed id would let the first case in this file
 * answer every later one from the cache and the Oxy call counts below would
 * assert nothing. Each case gets its own reader, which is also what makes them
 * order-independent.
 */
function freshViewer(): string {
  return `viewer-${randomUUID()}`;
}

function makeOxyClient(overrides: Partial<OxyClient> = {}): {
  client: OxyClient;
  getUserFollowing: ReturnType<typeof vi.fn>;
  getUserFollowers: ReturnType<typeof vi.fn>;
} {
  const getUserFollowing = vi.fn(async () => ({ following: ['a', 'b'] }));
  const getUserFollowers = vi.fn(async () => ({ followers: ['x', 'y', 'z'] }));
  const client = {
    getUserFollowing,
    getUserFollowers,
    getBlockedUsers: vi.fn(async () => []),
    getRestrictedUsers: vi.fn(async () => []),
    ...overrides,
  } as unknown as OxyClient;
  return { client, getUserFollowing, getUserFollowers };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadViewerFeedContext — viewer-graph resolution', () => {
  it('resolves following and followers exactly once each and threads both onto the context', async () => {
    const { client, getUserFollowing, getUserFollowers } = makeOxyClient();
    const viewer = freshViewer();

    const context = await loadViewerFeedContext(viewer, client);

    expect(getUserFollowing).toHaveBeenCalledTimes(1);
    expect(getUserFollowing).toHaveBeenCalledWith(viewer);
    expect(getUserFollowers).toHaveBeenCalledTimes(1);
    expect(getUserFollowers).toHaveBeenCalledWith(viewer);

    expect(context.followingIds).toEqual(['a', 'b']);
    expect(context.followerIds).toEqual(['x', 'y', 'z']);
  });

  it('soft-fails followers independently: a getUserFollowers error leaves followerIds empty but keeps following', async () => {
    const { client, getUserFollowing } = makeOxyClient({
      getUserFollowers: vi.fn(async () => {
        throw new Error('oxy followers down');
      }),
    });

    const context = await loadViewerFeedContext(freshViewer(), client);

    expect(getUserFollowing).toHaveBeenCalledTimes(1);
    expect(context.followingIds).toEqual(['a', 'b']);
    expect(context.followerIds).toEqual([]);
  });

  it('soft-fails following independently: a getUserFollowing error leaves followingIds empty but keeps followers', async () => {
    const { client } = makeOxyClient({
      getUserFollowing: vi.fn(async () => {
        throw new Error('oxy following down');
      }),
    });

    const context = await loadViewerFeedContext(freshViewer(), client);

    expect(context.followingIds).toEqual([]);
    expect(context.followerIds).toEqual(['x', 'y', 'z']);
  });

  it('resolves the two graph calls concurrently (following does not block followers)', async () => {
    let followingResolve: (() => void) | undefined;
    const followingGate = new Promise<void>((resolve) => {
      followingResolve = resolve;
    });
    const getUserFollowers = vi.fn(async () => ({ followers: ['x'] }));
    const getUserFollowing = vi.fn(async () => {
      await followingGate;
      return { following: ['a'] };
    });
    const client = {
      getUserFollowing,
      getUserFollowers,
      getBlockedUsers: vi.fn(async () => []),
      getRestrictedUsers: vi.fn(async () => []),
    } as unknown as OxyClient;

    const pending = loadViewerFeedContext(freshViewer(), client);

    // followers is dispatched WITHOUT waiting for following to settle → concurrent.
    // AWAITED rather than counted after N microtasks: each read now consults the
    // per-viewer cache first, so the dispatch is one Redis round trip away and a
    // fixed number of ticks proves nothing either way. `following` is still
    // gated, so this can only pass if the two do not serialise.
    await vi.waitFor(() => expect(getUserFollowers).toHaveBeenCalledTimes(1));

    followingResolve?.();
    const context = await pending;
    expect(context.followingIds).toEqual(['a']);
    expect(context.followerIds).toEqual(['x']);
  });

  it('anonymous viewers resolve no graph and never touch Oxy', async () => {
    const { client, getUserFollowing, getUserFollowers } = makeOxyClient();

    const context = await loadViewerFeedContext(undefined, client);

    expect(getUserFollowing).not.toHaveBeenCalled();
    expect(getUserFollowers).not.toHaveBeenCalled();
    expect(context.followingIds).toEqual([]);
    expect(context.followerIds).toEqual([]);
  });
});
