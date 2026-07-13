import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Group E — the controller populates `ctx.mutualIds` (Oxy mutuals ∪ federated
 * mutuals) ONLY for the Mutuals feed. The engine + heavy loads are mocked; the
 * context passed to `feedEngine.run` is captured for assertions.
 */

let capturedContext: Record<string, unknown> | undefined;
const engineRun = vi.fn(async (_def: unknown, ctx: Record<string, unknown>) => {
  capturedContext = ctx;
  return { slices: [], items: [], hasMore: false, nextCursor: undefined, totalCount: 0 };
});
vi.mock('../mtn/feed/engine/FeedEngine', () => ({
  feedEngine: {
    run: (...a: unknown[]) => engineRun(...(a as [unknown, Record<string, unknown>])),
    peekLatest: vi.fn(async () => undefined),
  },
}));

const getMutualUserIds = vi.fn(async () => ['oxymutual']);
vi.mock('../../server', () => ({
  oxy: {
    getUserFollowing: vi.fn(async () => ({ data: [] })),
    getMutualUserIds: (...a: unknown[]) => getMutualUserIds(...(a as [])),
  },
}));

vi.mock('../mtn/UserPrivacyManager', () => ({
  UserPrivacyManager: { loadPrivacyState: vi.fn(async () => ({ excludedUserIds: new Set() })) },
}));
vi.mock('../services/ListSubscriptionService', () => ({
  listSubscriptionService: { getSubscribedListMemberIds: vi.fn(async () => []) },
}));
vi.mock('../services/UserPreferenceService', () => ({
  userPreferenceService: { getUserBehavior: vi.fn(async () => undefined), getTopRegion: vi.fn(() => undefined) },
}));
vi.mock('../models/FederatedFollow', () => ({
  default: { distinct: vi.fn(async () => ['uriB']) },
}));
vi.mock('../models/FederatedActor', () => ({
  default: { find: vi.fn(() => ({ lean: vi.fn(async () => [{ oxyUserId: 'fedmutual' }]) })) },
}));
vi.mock('../models/MuteWord', () => ({ MuteWord: { find: vi.fn(() => ({ lean: vi.fn(async () => []) })) } }));
vi.mock('../models/UserSettings', () => ({ default: { findOne: vi.fn(() => ({ lean: vi.fn(async () => null) })) } }));

import { mtnFeedController } from '../mtn/controllers/feed.controller';

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}

beforeEach(() => {
  capturedContext = undefined;
  vi.clearAllMocks();
});

describe('MtnFeedController.getFeed → ctx.mutualIds', () => {
  it('builds mutualIds (Oxy ∪ federated) for a mutuals descriptor', async () => {
    const req = { query: { descriptor: 'mutuals' }, user: { id: 'viewer' } } as never;
    await mtnFeedController.getFeed(req, makeRes() as never);
    expect(engineRun).toHaveBeenCalledOnce();
    const mutualIds = capturedContext?.mutualIds as string[];
    expect(mutualIds).toEqual(expect.arrayContaining(['oxymutual', 'fedmutual']));
  });

  it('builds mutualIds for a For You descriptor (socialProof active by default)', async () => {
    // Phase 5: the For You default signal set enables `socialProof`, so the
    // controller resolves mutuals to widen the network-engager set.
    const req = { query: { descriptor: 'for_you' }, user: { id: 'viewer' } } as never;
    await mtnFeedController.getFeed(req, makeRes() as never);
    expect(getMutualUserIds).toHaveBeenCalled();
    const mutualIds = capturedContext?.mutualIds as string[];
    expect(mutualIds).toEqual(expect.arrayContaining(['oxymutual', 'fedmutual']));
  });

  it('For You still builds when the Oxy mutuals lookup fails (fail-soft)', async () => {
    // Phase 5: mutuals resolution must never break the feed. If the Oxy branch
    // throws, `computeMutualIds` degrades to the surviving federated branch and the
    // feed still serves (200) with the partial mutual set.
    getMutualUserIds.mockRejectedValueOnce(new Error('oxy down'));
    const req = { query: { descriptor: 'for_you' }, user: { id: 'viewer' } } as never;
    const res = makeRes();
    await mtnFeedController.getFeed(req, res as never);
    expect(engineRun).toHaveBeenCalledOnce();
    expect((res.body as { success: boolean }).success).toBe(true);
    // Oxy branch failed → only the federated mutual survives (never throws).
    expect(capturedContext?.mutualIds).toEqual(['fedmutual']);
  });

  it('does NOT compute mutualIds for a descriptor that uses neither (following)', async () => {
    const req = { query: { descriptor: 'following' }, user: { id: 'viewer' } } as never;
    await mtnFeedController.getFeed(req, makeRes() as never);
    expect(capturedContext?.mutualIds).toBeUndefined();
    expect(getMutualUserIds).not.toHaveBeenCalled();
  });

  it('does NOT compute mutualIds for an anonymous mutuals request', async () => {
    const req = { query: { descriptor: 'mutuals' }, user: undefined } as never;
    await mtnFeedController.getFeed(req, makeRes() as never);
    expect(capturedContext?.mutualIds).toBeUndefined();
  });
});
