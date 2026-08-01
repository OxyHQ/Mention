import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * `FeedGeneratorFeed` — serves a `feedgen|<uri>` descriptor by pulling a Bluesky
 * feed generator's OUTPUT live and importing it as NATIVE posts.
 *
 * ## What is real here and what is mocked, and why
 *
 * The generator row and the imported posts are REAL Postgres rows. That is the
 * point of the rewrite: the assertion that matters is that the class re-orders
 * the loaded posts into the generator's RANKING, and the previous version proved
 * that against a hand-written array returned by a mocked `Post.find`. It would
 * have passed just as happily if the query selected the wrong column, matched
 * nothing, or lost the URI→post mapping — the three ways this can actually break
 * now that `federation.activityId` is a real indexed column reached by a real
 * `inArray`.
 *
 * Only the genuinely EXTERNAL edges stay mocked: `getFeed`/`importPostViews`
 * (network calls to a remote atproto service) and `postHydrationService` (a
 * whole DTO pipeline with its own suite). Mocking those keeps this a test of
 * ORCHESTRATION — which is what it was always for.
 */

const mocks = vi.hoisted(() => ({
  getFeed: vi.fn(),
  importPostViews: vi.fn(),
  hydratePosts: vi.fn(),
}));

vi.mock('../connectors/atproto/post.mapper', () => ({
  getFeed: mocks.getFeed,
  importPostViews: mocks.importPostViews,
}));

vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: mocks.hydratePosts },
}));

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { feedGenerators } from '../db/schema/feeds';
import { posts } from '../db/schema/posts';
import { deletePostRecord, insertPostRecord } from '../db/posts/postRepository';
import { FeedGeneratorFeed } from '../mtn/feed/feeds/FeedGeneratorFeed';

const GEN_URI = 'at://did:plc:creator0000000000000000/app.bsky.feed.generator/cool';
const AUTHOR = 'oxy-feedgen-author';

let db: Database;
const createdPosts: string[] = [];
const createdGenerators: string[] = [];

/** A remote PostView the way `getFeed` returns it (only the fields the class reads). */
function postView(uri: string) {
  return { uri, author: { did: 'did:plc:a' } };
}

/** Insert a real post carrying `federation.activityId = uri` — the join key. */
async function importedPost(uri: string) {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: `body for ${uri}`, tag: 'en' }] },
    federation: { activityId: uri, actorUri: 'https://remote.example/users/a' },
  });
  createdPosts.push(record.id);
  return record;
}

/** Register the descriptor's generator as atproto-backed (or not). */
async function generator(sourceNetwork: 'atproto' | null) {
  const [row] = await db
    .insert(feedGenerators)
    .values({
      uri: GEN_URI,
      name: 'Cool feed',
      algorithm: 'cool',
      createdBy: AUTHOR,
      // The schema's all-or-nothing CHECK: the three source columns move together.
      ...(sourceNetwork
        ? { sourceNetwork, sourceServiceDid: 'did:web:feeds.example', sourceSyncedAt: new Date() }
        : {}),
    })
    .returning({ id: feedGenerators.id });
  createdGenerators.push(row.id);
  return row;
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Hydration is mocked, so it echoes the ids it was handed — which is exactly
  // the ORDER this suite is asserting on.
  mocks.hydratePosts.mockImplementation((records: Array<{ id: string }>) =>
    records.map((record) => ({ id: record.id })),
  );
});

afterEach(async () => {
  if (createdGenerators.length > 0) {
    await db.delete(feedGenerators).where(inArray(feedGenerators.id, createdGenerators.splice(0)));
  }
  for (const id of createdPosts.splice(0).reverse()) {
    await deletePostRecord(id);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('FeedGeneratorFeed.fetch', () => {
  it('returns the imported posts in the generator ranking order, not the database order', async () => {
    await generator('atproto');

    const uriA = 'at://did:plc:a/app.bsky.feed.post/a';
    const uriB = 'at://did:plc:a/app.bsky.feed.post/b';
    const uriC = 'at://did:plc:a/app.bsky.feed.post/c';
    const views = [postView(uriA), postView(uriB), postView(uriC)];

    // Insert in an order that is NOT the ranking, so echoing the query order
    // would produce a different answer and fail.
    const postB = await importedPost(uriB);
    const postC = await importedPost(uriC);
    const postA = await importedPost(uriA);

    mocks.getFeed.mockResolvedValue({ posts: views, cursor: 'next-cursor' });
    mocks.importPostViews.mockResolvedValue([uriA, uriB, uriC]);

    const feed = new FeedGeneratorFeed(GEN_URI);
    const response = await feed.fetch({ limit: 30, cursor: undefined }, { currentUserId: 'viewer' });

    expect(mocks.getFeed).toHaveBeenCalledWith(GEN_URI, { cursor: undefined, limit: 30 });
    expect(mocks.importPostViews).toHaveBeenCalledWith(views);

    // The generator's ranking (a, b, c), against real rows stored (b, c, a).
    expect(response.items.map((item) => item.id)).toEqual([postA.id, postB.id, postC.id]);
    expect(response.slices).toEqual([]);
    expect(response.totalCount).toBe(3);
    expect(response.hasMore).toBe(true);
    expect(response.nextCursor).toBe('next-cursor');
    // Boosts/quote embeds hydrate their original at depth ≥ 1.
    expect(mocks.hydratePosts.mock.calls[0][1]).toMatchObject({ maxDepth: 1 });
  });

  it('drops a URI whose import produced no local post (never renders blank)', async () => {
    await generator('atproto');

    const uriA = 'at://did:plc:a/app.bsky.feed.post/a';
    const uriGone = 'at://did:plc:a/app.bsky.feed.post/gone';
    const postA = await importedPost(uriA);

    mocks.getFeed.mockResolvedValue({ posts: [postView(uriA), postView(uriGone)], cursor: undefined });
    // `importPostViews` reports both, but only `uriA` ever materialized a row.
    mocks.importPostViews.mockResolvedValue([uriA, uriGone]);

    const feed = new FeedGeneratorFeed(GEN_URI);
    const response = await feed.fetch({ limit: 30 }, {});

    expect(response.items.map((item) => item.id)).toEqual([postA.id]);
    expect(response.hasMore).toBe(false);
    expect(response.nextCursor).toBeUndefined();
  });

  it('serves an empty page for a generator that is not atproto-backed', async () => {
    await generator(null);

    const feed = new FeedGeneratorFeed(GEN_URI);
    const response = await feed.fetch({ limit: 30 }, {});

    expect(response.items).toEqual([]);
    expect(response.slices).toEqual([]);
    expect(response.hasMore).toBe(false);
    // No remote dereference for a non-atproto generator.
    expect(mocks.getFeed).not.toHaveBeenCalled();
  });

  it('serves an empty page for a generator that is not registered at all', async () => {
    const feed = new FeedGeneratorFeed(GEN_URI);
    const response = await feed.fetch({ limit: 30 }, {});

    expect(response.items).toEqual([]);
    expect(mocks.getFeed).not.toHaveBeenCalled();
  });

  it('reports hasMore from the cursor even when nothing imported on this page', async () => {
    await generator('atproto');
    mocks.getFeed.mockResolvedValue({
      posts: [postView('at://did:plc:a/app.bsky.feed.post/x')],
      cursor: 'more',
    });
    mocks.importPostViews.mockResolvedValue([]);

    const feed = new FeedGeneratorFeed(GEN_URI);
    const response = await feed.fetch({ limit: 30 }, {});

    expect(response.items).toEqual([]);
    expect(response.hasMore).toBe(true);
    expect(response.nextCursor).toBe('more');
    expect(mocks.hydratePosts).not.toHaveBeenCalled();
  });

  it('loads by federation.activityId — a post with no AP id is never matched', async () => {
    // Guards the join key itself. `importPostViews` returns AT-URIs; the load
    // matches `federation_activity_id`. A native post (no AP id at all) sharing
    // nothing but an author must not leak into a generator feed.
    await generator('atproto');
    const uriA = 'at://did:plc:a/app.bsky.feed.post/a';
    const postA = await importedPost(uriA);

    const native = await insertPostRecord({
      oxyUserId: AUTHOR,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'native, not federated', tag: 'en' }] },
    });
    createdPosts.push(native.id);

    const [nativeRow] = await db
      .select({ activityId: posts.federationActivityId })
      .from(posts)
      .where(eq(posts.id, native.id));
    expect(nativeRow.activityId).toBeNull();

    mocks.getFeed.mockResolvedValue({ posts: [postView(uriA)], cursor: undefined });
    mocks.importPostViews.mockResolvedValue([uriA]);

    const feed = new FeedGeneratorFeed(GEN_URI);
    const response = await feed.fetch({ limit: 30 }, {});

    expect(response.items.map((item) => item.id)).toEqual([postA.id]);
  });
});

describe('FeedGeneratorFeed.peekLatest', () => {
  it('returns the single newest imported post for an atproto-backed generator', async () => {
    await generator('atproto');
    const uri = 'at://did:plc:a/app.bsky.feed.post/top';
    const top = await importedPost(uri);

    mocks.getFeed.mockResolvedValue({ posts: [postView(uri)], cursor: 'c' });
    mocks.importPostViews.mockResolvedValue([uri]);

    const feed = new FeedGeneratorFeed(GEN_URI);
    const latest = await feed.peekLatest({ currentUserId: 'viewer' });

    expect(latest).toEqual({ id: top.id });
    expect(mocks.getFeed).toHaveBeenCalledWith(GEN_URI, { limit: 1 });
  });

  it('returns undefined for a non-atproto generator', async () => {
    await generator(null);
    const feed = new FeedGeneratorFeed(GEN_URI);
    expect(await feed.peekLatest({})).toBeUndefined();
    expect(mocks.getFeed).not.toHaveBeenCalled();
  });
});
