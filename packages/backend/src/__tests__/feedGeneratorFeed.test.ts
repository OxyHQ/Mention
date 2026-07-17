import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `FeedGeneratorFeed` — serves a `feedgen|<uri>` descriptor by pulling a Bluesky
 * feed generator's OUTPUT live and importing it as NATIVE posts.
 *
 * The class's collaborators are mocked so the test isolates its ORCHESTRATION:
 *  - only an atproto-backed `FeedGenerator` dereferences the remote feed;
 *  - `getFeed` → `importPostViews` imports the returned PostViews as native posts;
 *  - the imported `Post` docs are re-ordered to the generator's RANKING (the URI
 *    order `importPostViews` returns), NOT the DB return order;
 *  - the atproto cursor drives `hasMore` / `nextCursor`.
 */

const mocks = vi.hoisted(() => ({
  generatorLean: vi.fn(),
  getFeed: vi.fn(),
  importPostViews: vi.fn(),
  postLean: vi.fn(),
  hydratePosts: vi.fn(),
  postFind: vi.fn(),
}));

vi.mock('../models/FeedGenerator', () => ({
  FeedGenerator: {
    findOne: () => ({ select: () => ({ lean: () => mocks.generatorLean() }) }),
  },
}));

vi.mock('../models/Post', () => ({
  Post: {
    find: (...args: unknown[]) => {
      mocks.postFind(...args);
      return { select: () => ({ lean: () => mocks.postLean() }) };
    },
  },
}));

vi.mock('../connectors/atproto/post.mapper', () => ({
  getFeed: mocks.getFeed,
  importPostViews: mocks.importPostViews,
}));

vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: mocks.hydratePosts },
}));

import { FeedGeneratorFeed } from '../mtn/feed/feeds/FeedGeneratorFeed';

const GEN_URI = 'at://did:plc:creator0000000000000000/app.bsky.feed.generator/cool';

/** A remote PostView the way `getFeed` returns it (only the fields the class reads). */
function postView(uri: string) {
  return { uri, author: { did: 'did:plc:a' } };
}

/** A native `Post` doc keyed on its AT-URI (`federation.activityId`). */
function postDoc(uri: string, id: string) {
  return { _id: id, id, federation: { activityId: uri } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hydratePosts.mockImplementation((docs: Array<{ id: string }>) => docs.map((doc) => ({ id: doc.id })));
});

describe('FeedGeneratorFeed.fetch', () => {
  it('imports the getFeed posts as native posts and returns them in the generator ranking order', async () => {
    mocks.generatorLean.mockResolvedValue({ source: { network: 'atproto' } });

    const uriA = 'at://did:plc:a/app.bsky.feed.post/a';
    const uriB = 'at://did:plc:a/app.bsky.feed.post/b';
    const uriC = 'at://did:plc:a/app.bsky.feed.post/c';
    const views = [postView(uriA), postView(uriB), postView(uriC)];

    mocks.getFeed.mockResolvedValue({ posts: views, cursor: 'next-cursor' });
    // Ranking order from the remote generator (a, b, c).
    mocks.importPostViews.mockResolvedValue([uriA, uriB, uriC]);
    // The DB returns the docs in a DIFFERENT order — the class must re-order to the
    // ranking (a, b, c), not echo the query order (b, c, a).
    mocks.postLean.mockResolvedValue([postDoc(uriB, 'B'), postDoc(uriC, 'C'), postDoc(uriA, 'A')]);

    const feed = new FeedGeneratorFeed(GEN_URI);
    const response = await feed.fetch({ limit: 30, cursor: undefined }, { currentUserId: 'viewer' });

    // getFeed dereferenced the descriptor's URI; importPostViews received the views.
    expect(mocks.getFeed).toHaveBeenCalledWith(GEN_URI, { cursor: undefined, limit: 30 });
    expect(mocks.importPostViews).toHaveBeenCalledWith(views);

    // Returned as flat items in the generator's ranking order (a, b, c).
    expect(response.items.map((item) => item.id)).toEqual(['A', 'B', 'C']);
    expect(response.slices).toEqual([]);
    expect(response.totalCount).toBe(3);
    // The atproto cursor drives pagination.
    expect(response.hasMore).toBe(true);
    expect(response.nextCursor).toBe('next-cursor');
    // Boosts/quote embeds hydrate their original at depth ≥ 1.
    expect(mocks.hydratePosts.mock.calls[0][1]).toMatchObject({ maxDepth: 1 });
  });

  it('drops a URI whose import produced no local post (never renders blank)', async () => {
    mocks.generatorLean.mockResolvedValue({ source: { network: 'atproto' } });
    const uriA = 'at://did:plc:a/app.bsky.feed.post/a';
    const uriGone = 'at://did:plc:a/app.bsky.feed.post/gone';

    mocks.getFeed.mockResolvedValue({ posts: [postView(uriA), postView(uriGone)], cursor: undefined });
    mocks.importPostViews.mockResolvedValue([uriA, uriGone]);
    // Only `uriA` materialized to a Post; `uriGone` failed to import.
    mocks.postLean.mockResolvedValue([postDoc(uriA, 'A')]);

    const feed = new FeedGeneratorFeed(GEN_URI);
    const response = await feed.fetch({ limit: 30 }, {});

    expect(response.items.map((item) => item.id)).toEqual(['A']);
    // Last page (no cursor) → no more.
    expect(response.hasMore).toBe(false);
    expect(response.nextCursor).toBeUndefined();
  });

  it('serves an empty page for a generator that is not atproto-backed', async () => {
    mocks.generatorLean.mockResolvedValue(null);

    const feed = new FeedGeneratorFeed(GEN_URI);
    const response = await feed.fetch({ limit: 30 }, {});

    expect(response.items).toEqual([]);
    expect(response.slices).toEqual([]);
    expect(response.hasMore).toBe(false);
    // No remote dereference for an unknown / non-atproto generator.
    expect(mocks.getFeed).not.toHaveBeenCalled();
  });

  it('reports hasMore from the cursor even when nothing imported on this page', async () => {
    mocks.generatorLean.mockResolvedValue({ source: { network: 'atproto' } });
    mocks.getFeed.mockResolvedValue({ posts: [postView('at://did:plc:a/app.bsky.feed.post/x')], cursor: 'more' });
    mocks.importPostViews.mockResolvedValue([]);

    const feed = new FeedGeneratorFeed(GEN_URI);
    const response = await feed.fetch({ limit: 30 }, {});

    expect(response.items).toEqual([]);
    expect(response.hasMore).toBe(true);
    expect(response.nextCursor).toBe('more');
    expect(mocks.hydratePosts).not.toHaveBeenCalled();
  });
});

describe('FeedGeneratorFeed.peekLatest', () => {
  it('returns the single newest imported post for an atproto-backed generator', async () => {
    mocks.generatorLean.mockResolvedValue({ source: { network: 'atproto' } });
    const uri = 'at://did:plc:a/app.bsky.feed.post/top';
    mocks.getFeed.mockResolvedValue({ posts: [postView(uri)], cursor: 'c' });
    mocks.importPostViews.mockResolvedValue([uri]);
    mocks.postLean.mockResolvedValue([postDoc(uri, 'TOP')]);

    const feed = new FeedGeneratorFeed(GEN_URI);
    const latest = await feed.peekLatest({ currentUserId: 'viewer' });

    expect(latest).toEqual({ id: 'TOP' });
    expect(mocks.getFeed).toHaveBeenCalledWith(GEN_URI, { limit: 1 });
  });

  it('returns undefined for a non-atproto generator', async () => {
    mocks.generatorLean.mockResolvedValue(null);
    const feed = new FeedGeneratorFeed(GEN_URI);
    expect(await feed.peekLatest({})).toBeUndefined();
    expect(mocks.getFeed).not.toHaveBeenCalled();
  });
});
