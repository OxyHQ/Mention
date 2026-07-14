import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The MTN feed controller resolves a FeedDefinition and runs the FeedEngine for
 * engine-owned descriptors; unknown descriptors → 400. The engine + heavy loads
 * are mocked so this focuses on the controller's resolve → run → respond flow.
 */

const engineRun = vi.fn(async () => ({
  slices: [],
  items: [{ id: 'p1', user: { id: 'u1' } }],
  hasMore: false,
  nextCursor: undefined,
  totalCount: 1,
}));
vi.mock('../mtn/feed/engine/FeedEngine', () => ({
  feedEngine: { run: (...a: unknown[]) => engineRun(...(a as [])), peekLatest: vi.fn(async () => undefined) },
}));

// Avoid loading server.ts (oxy client) side effects.
vi.mock('../../server', () => ({ oxy: { getUserFollowing: vi.fn(async () => ({ data: [] })) } }));

vi.mock('../mtn/UserPrivacyManager', () => ({
  UserPrivacyManager: { loadPrivacyState: vi.fn(async () => ({ excludedUserIds: new Set() })) },
}));
vi.mock('../services/ListSubscriptionService', () => ({
  listSubscriptionService: { getSubscribedListMemberIds: vi.fn(async () => []) },
}));
vi.mock('../services/UserPreferenceService', () => ({
  userPreferenceService: { getUserBehavior: vi.fn(async () => undefined), getTopRegion: vi.fn(() => undefined) },
}));
vi.mock('../models/FederatedFollow', () => ({ default: { distinct: vi.fn(async () => []) } }));
vi.mock('../models/FederatedActor', () => ({ default: { find: vi.fn(() => ({ lean: vi.fn(async () => []) })) } }));
vi.mock('../models/MuteWord', () => ({ MuteWord: { find: vi.fn(() => ({ lean: vi.fn(async () => []) })) } }));
vi.mock('../models/UserSettings', () => ({ default: { findOne: vi.fn(() => ({ lean: vi.fn(async () => null) })) } }));

// Driveable anon-feed cache: read defaults to a miss so the engine still runs
// (existing tests unaffected); individual tests override to assert hit/gating.
const anonCache = vi.hoisted(() => ({
  read: vi.fn(async (): Promise<unknown> => null),
  write: vi.fn(async (): Promise<void> => undefined),
  buildKey: vi.fn((): string => 'anon-key'),
}));
vi.mock('../services/anonFeedCache', () => ({ anonFeedCache: anonCache }));

// Federated sync-on-view: the side effect an empty author feed triggers. Defaults
// to "nothing to sync" so unrelated tests are unaffected.
const syncOnProfileView = vi.hoisted(() => vi.fn(async (): Promise<boolean> => false));
vi.mock('../connectors/federatedProfileSync', () => ({
  federatedProfileSync: { syncOnProfileView },
}));

import { mtnFeedController } from '../mtn/controllers/feed.controller';

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (c: number) => MockRes;
  json: (b: unknown) => MockRes;
}
function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MtnFeedController.getFeed → engine', () => {
  it('runs the engine for a for_you descriptor and returns the response', async () => {
    const req = { query: { descriptor: 'for_you' }, user: undefined } as never;
    const res = makeRes();
    await mtnFeedController.getFeed(req, res as never);
    expect(engineRun).toHaveBeenCalledOnce();
    const body = res.body as { success: boolean; data: { items: unknown[] } };
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
  });

  it('400s an invalid descriptor', async () => {
    const req = { query: { descriptor: 'not_a_feed' }, user: undefined } as never;
    const res = makeRes();
    await mtnFeedController.getFeed(req, res as never);
    expect(res.statusCode).toBe(400);
    expect(engineRun).not.toHaveBeenCalled();
  });

  it('400s a missing descriptor', async () => {
    const req = { query: {}, user: undefined } as never;
    const res = makeRes();
    await mtnFeedController.getFeed(req, res as never);
    expect(res.statusCode).toBe(400);
  });
});

describe('MtnFeedController.getFeed → federated profile sync-on-view', () => {
  /** Make the engine return an empty page (the discovery trigger). */
  function engineReturnsEmpty(): void {
    engineRun.mockResolvedValueOnce({
      slices: [], items: [], hasMore: false, nextCursor: undefined, totalCount: 0,
    });
  }

  it('syncs the author and marks the page pending when a profile feed comes back empty', async () => {
    engineReturnsEmpty();
    syncOnProfileView.mockResolvedValueOnce(true);
    const req = { query: { descriptor: 'author|fed1' }, user: { id: 'viewer1' } } as never;
    const res = makeRes();

    await mtnFeedController.getFeed(req, res as never);

    expect(syncOnProfileView).toHaveBeenCalledWith('fed1');
    const body = res.body as { data: { pending?: boolean } };
    expect(body.data.pending).toBe(true);
  });

  it('passes the author id through for a tab-scoped descriptor', async () => {
    engineReturnsEmpty();
    const req = { query: { descriptor: 'author|fed1|media' }, user: { id: 'viewer1' } } as never;
    const res = makeRes();

    await mtnFeedController.getFeed(req, res as never);

    expect(syncOnProfileView).toHaveBeenCalledWith('fed1');
  });

  it('leaves the page un-pending when the author has nothing left to sync', async () => {
    engineReturnsEmpty();
    syncOnProfileView.mockResolvedValueOnce(false);
    const req = { query: { descriptor: 'author|local1' }, user: { id: 'viewer1' } } as never;
    const res = makeRes();

    await mtnFeedController.getFeed(req, res as never);

    const body = res.body as { data: { pending?: boolean } };
    expect(body.data.pending).toBeUndefined();
  });

  it('does not sync when the profile feed already has posts', async () => {
    const req = { query: { descriptor: 'author|fed1' }, user: { id: 'viewer1' } } as never;
    const res = makeRes();

    await mtnFeedController.getFeed(req, res as never);

    expect(syncOnProfileView).not.toHaveBeenCalled();
  });

  it('does not sync on a later page — an empty page 2 is just the end of the feed', async () => {
    engineReturnsEmpty();
    const req = { query: { descriptor: 'author|fed1', cursor: '123:abc' }, user: { id: 'viewer1' } } as never;
    const res = makeRes();

    await mtnFeedController.getFeed(req, res as never);

    expect(syncOnProfileView).not.toHaveBeenCalled();
  });

  it('does not sync for a non-author descriptor', async () => {
    engineReturnsEmpty();
    const req = { query: { descriptor: 'for_you' }, user: { id: 'viewer1' } } as never;
    const res = makeRes();

    await mtnFeedController.getFeed(req, res as never);

    expect(syncOnProfileView).not.toHaveBeenCalled();
  });

  it('never caches a pending page for anonymous viewers', async () => {
    engineReturnsEmpty();
    syncOnProfileView.mockResolvedValueOnce(true);
    const req = { query: { descriptor: 'author|fed1' }, user: undefined } as never;
    const res = makeRes();

    await mtnFeedController.getFeed(req, res as never);

    // Caching it would pin every anonymous viewer to the "still importing"
    // answer for the whole TTL, long after the posts have landed.
    expect(anonCache.write).not.toHaveBeenCalled();
  });
});

describe('MtnFeedController.getFeed → anonymous cache', () => {
  it('reads the mtn-namespaced anon cache before the engine and writes it after a miss', async () => {
    anonCache.read.mockResolvedValueOnce(null);
    const req = { query: { descriptor: 'for_you' }, user: undefined } as never;
    const res = makeRes();

    await mtnFeedController.getFeed(req, res as never);

    expect(anonCache.buildKey).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'mtn', type: 'for_you' }),
    );
    expect(anonCache.read).toHaveBeenCalledWith('anon-key');
    expect(engineRun).toHaveBeenCalledOnce();
    // The freshly built page is persisted for the next anonymous viewer.
    expect(anonCache.write).toHaveBeenCalledWith('anon-key', expect.objectContaining({ items: expect.any(Array) }));
  });

  it('returns the cached page on a hit without running the engine', async () => {
    const cached = { slices: [], items: [{ id: 'cachedPost', user: { id: 'u9' } }], hasMore: false, totalCount: 1 };
    anonCache.read.mockResolvedValueOnce(cached);
    const req = { query: { descriptor: 'for_you' }, user: undefined } as never;
    const res = makeRes();

    await mtnFeedController.getFeed(req, res as never);

    expect(engineRun).not.toHaveBeenCalled();
    expect(anonCache.write).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: true, data: cached });
  });

  it('never reads or writes the anon cache for an authenticated viewer', async () => {
    const req = { query: { descriptor: 'for_you' }, user: { id: 'viewer1' } } as never;
    const res = makeRes();

    await mtnFeedController.getFeed(req, res as never);

    expect(anonCache.buildKey).not.toHaveBeenCalled();
    expect(anonCache.read).not.toHaveBeenCalled();
    expect(anonCache.write).not.toHaveBeenCalled();
    expect(engineRun).toHaveBeenCalledOnce();
  });
});
