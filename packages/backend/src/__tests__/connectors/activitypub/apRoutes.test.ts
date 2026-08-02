import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract tests for the ActivityPub actor/outbox/dereference routes, against
 * REAL POST ROWS:
 *
 *  1. The actor JSON advertises the profile banner as AP `image` (Mastodon
 *     header) when the user has one, and omits it cleanly when absent.
 *  2. The outbox page reuses `activityPubConnector.buildCreateNoteActivity`
 *     (ONE Note builder shared with push delivery), and SELECTS the right posts
 *     in the right order with a working keyset cursor.
 *  3. A single post dereferences to its AP Note (200) only when PUBLIC +
 *     PUBLISHED and owned by the named user; otherwise 404.
 *
 * The Note BUILDER stays mocked — it is a pure function with its own suite
 * (`buildCreateNoteActivity.test.ts`), and stubbing it is what lets these
 * assertions be about which posts the route selected and what context it
 * threaded. Everything that decides WHICH posts, and the banner, is a real row.
 *
 * That distinction is the whole reason for the rewrite. The previous version
 * mocked `Post.find` and asserted the FILTER OBJECT (`parentPostId: null`,
 * `$or: …`), which cannot tell a correct query from one that matches nothing —
 * and pinned a Mongo spelling that has since become SQL, so it would go red on a
 * correct port and green on a broken one. Two user-visible bugs live exactly
 * there and are now covered by rows:
 *
 *   - the outbox scope is `is_reply = false`, NOT `parent_post_id IS NULL`.
 *     `parent_post_id` is `ON DELETE SET NULL`, so an ORPHANED REPLY has a null
 *     parent and the old predicate would publish it to the fediverse as a
 *     top-level Note;
 *   - the page cursor is `(created_at, id)` with `id` an opaque `text`. Reading
 *     a timestamp out of the id, or validating it as an ObjectId, strands every
 *     post created since the uuid cutover.
 */

const AP_ACCEPT = 'application/activity+json';
const VALID_ID = '507f1f77bcf86cd799439011';

const mocks = vi.hoisted(() => ({
  resolveOxyUser: vi.fn(),
  getPublicKey: vi.fn(),
  fetchPublicKey: vi.fn(),
  buildCreateNoteActivity: vi.fn(),
  resolveReplyContext: vi.fn(),
  resolveMentionContext: vi.fn(),
  resolveMentionContextByPost: vi.fn(),
  resolvePollContext: vi.fn(),
  resolvePollContextByPost: vi.fn(),
  resolveQuoteContext: vi.fn(),
  resolveQuoteContextByPost: vi.fn(),
  resolveAvatarUrl: vi.fn(),
  resolveMediaRef: vi.fn(),
  getServiceOxyClient: vi.fn(),
  getUserFollowers: vi.fn(),
  getUserFollowing: vi.fn(),
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../middleware/rateLimitStore', () => ({ RedisStore: class {} }));
vi.mock('../../../queue/producers', () => ({ enqueueInboxActivity: vi.fn() }));

vi.mock('../../../connectors/activitypub/ActivityPubConnector', () => ({
  activityPubConnector: {
    buildCreateNoteActivity: (...args: unknown[]) => mocks.buildCreateNoteActivity(...args),
    resolveReplyContext: (...args: unknown[]) => mocks.resolveReplyContext(...args),
    resolveMentionContext: (...args: unknown[]) => mocks.resolveMentionContext(...args),
    resolveMentionContextByPost: (...args: unknown[]) => mocks.resolveMentionContextByPost(...args),
    resolvePollContext: (...args: unknown[]) => mocks.resolvePollContext(...args),
    resolvePollContextByPost: (...args: unknown[]) => mocks.resolvePollContextByPost(...args),
    resolveQuoteContext: (...args: unknown[]) => mocks.resolveQuoteContext(...args),
    resolveQuoteContextByPost: (...args: unknown[]) => mocks.resolveQuoteContextByPost(...args),
    fetchPublicKey: vi.fn(),
    processInboxActivity: vi.fn(),
  },
}));

vi.mock('../../../connectors/activitypub/crypto', () => ({
  verifyHttpSignature: vi.fn(),
  getPublicKey: (...args: unknown[]) => mocks.getPublicKey(...args),
}));

// The actor GET (banner) + follow-collection routes now live in the shared engine
// (bound in `engine.routes.ts`); mock actor.service to control the inbox key
// resolver + short-circuit its heavy load chain (the inbox is not tested here).
vi.mock('../../../connectors/activitypub/actor.service', () => ({
  actorService: {
    fetchPublicKey: (...args: unknown[]) => mocks.fetchPublicKey(...args),
    getOrFetchActor: vi.fn(),
    fetchRemoteActor: vi.fn(),
    refreshActorInBackground: vi.fn(),
    resolveActorOxyUserId: vi.fn(),
    resolveWebFinger: vi.fn(),
  },
}));

vi.mock('../../../connectors/activitypub/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../connectors/activitypub/constants')>();
  return { ...actual, resolveOxyUser: (...args: unknown[]) => mocks.resolveOxyUser(...args) };
});

vi.mock('../../../utils/mediaResolver', () => ({
  resolveAvatarUrl: (...args: unknown[]) => mocks.resolveAvatarUrl(...args),
  resolveMediaRef: (...args: unknown[]) => mocks.resolveMediaRef(...args),
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: (...args: unknown[]) => mocks.getServiceOxyClient(...args),
}));

import { afterAll, afterEach, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { userSettings } from '../../../db/schema/userProfile';
import {
  clearFederationScope,
  federationScope,
  seedPost,
} from '../../helpers/federationFixtures';
import type { PostRecord } from '../../../db/posts/postRecord';
import apRoutes from '../../../connectors/activitypub/routes/ap.routes';
import { actorRouter } from '../../../connectors/activitypub/routes/engine.routes';
import { AP_CONTEXT } from '@oxyhq/federation';

const app = express();
app.use(express.json());
// The engine router (actor GET, followers/following) + Mention's content router
// (outbox/featured/dereference) on the SAME `/ap` prefix, as in `app.ts`.
app.use('/ap', actorRouter);
app.use('/ap', apRoutes);

const scope = federationScope('ap-routes');
const ALICE = scope.user('alice');

/** Overwrite the banner setting for ALICE, or clear it when passed null. */
async function setBanner(profileHeaderImage: string | null): Promise<void> {
  await getDb()
    .insert(userSettings)
    .values({ oxyUserId: ALICE, profileHeaderImage })
    .onConflictDoUpdate({ target: userSettings.oxyUserId, set: { profileHeaderImage } });
}

/** A post owned by ALICE — the outbox/featured/dereference subject. */
async function alicePost(overrides: Partial<Parameters<typeof seedPost>[1]> = {}): Promise<PostRecord> {
  return seedPost(scope, { oxyUserId: ALICE, ...overrides });
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearFederationScope(scope);
  await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, ALICE));
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/alice#main-key',
    publicKeyPem: 'PEM',
  });
  mocks.resolveAvatarUrl.mockReturnValue(undefined);
  // The follow collections read the Oxy follow graph through the service client.
  mocks.getServiceOxyClient.mockReturnValue({
    getUserFollowers: mocks.getUserFollowers,
    getUserFollowing: mocks.getUserFollowing,
  });
  mocks.getUserFollowers.mockResolvedValue({ followers: [], total: 0, hasMore: false });
  mocks.getUserFollowing.mockResolvedValue({ following: [], total: 0, hasMore: false });
  // Default: not a reply (or unresolvable parent) — the dereference route serves
  // the Note with no `inReplyTo`. Individual tests override for a reply post.
  mocks.resolveReplyContext.mockResolvedValue(null);
  // Default: no @mentions resolve — the outbox/featured batch resolver returns an
  // empty map and the single-post dereference resolver returns null.
  mocks.resolveMentionContext.mockResolvedValue(null);
  mocks.resolveMentionContextByPost.mockResolvedValue(new Map());
  // Default: no post carries a poll — the batch resolver returns an empty map and
  // the single-post dereference resolver returns null (serves a plain Note).
  mocks.resolvePollContext.mockResolvedValue(null);
  mocks.resolvePollContextByPost.mockResolvedValue(new Map());
  // Default: no post is a quote — the batch resolver returns an empty map and the
  // single-post dereference resolver returns null (serves a Note with no quote).
  mocks.resolveQuoteContext.mockResolvedValue(null);
  mocks.resolveQuoteContextByPost.mockResolvedValue(new Map());
});

describe('GET /ap/users/:username — actor image (banner)', () => {
  beforeEach(() => {
    mocks.resolveOxyUser.mockResolvedValue({
      _id: ALICE,
      name: { displayName: 'Alice' },
      avatar: null,
      createdAt: '2020-01-01T00:00:00.000Z',
    });
  });

  it('advertises the banner as AP image when the user has a profileHeaderImage', async () => {
    // A REAL `user_settings` row. Under the previous mock this passed while the
    // production read went to a Mongoose model nothing writes any more, so every
    // actor JSON omitted `image` and no banner ever reached Mastodon.
    await setBanner('banner-id');
    mocks.resolveMediaRef.mockReturnValue({ url: 'https://cloud.oxy.so/banner-id' });

    const res = await request(app).get('/ap/users/alice').set('Accept', AP_ACCEPT).expect(200);

    expect(mocks.resolveMediaRef).toHaveBeenCalledWith('banner-id');
    expect(res.body.image).toEqual({ type: 'Image', url: 'https://cloud.oxy.so/banner-id' });
  });

  it('omits image when the user has no settings row at all', async () => {
    const res = await request(app).get('/ap/users/alice').set('Accept', AP_ACCEPT).expect(200);

    expect(res.body.image).toBeUndefined();
    expect('image' in res.body).toBe(false);
  });

  it('omits image when the settings row exists but carries no banner', async () => {
    // Distinct from the case above: the row is present and the column is NULL,
    // which is what a user who opened settings and never set a header looks like.
    await setBanner(null);

    const res = await request(app).get('/ap/users/alice').set('Accept', AP_ACCEPT).expect(200);

    expect('image' in res.body).toBe(false);
  });

  it('advertises the featured collection so Mastodon can fetch pinned posts on discovery', async () => {
    const res = await request(app).get('/ap/users/alice').set('Accept', AP_ACCEPT).expect(200);
    expect(res.body.featured).toBe('https://mention.earth/ap/users/alice/collections/featured');
  });

  it('omits image when the banner cannot resolve to an absolute URL', async () => {
    await setBanner('banner-id');
    // Degraded passthrough (unresolvable id) — not an absolute http(s) URL.
    mocks.resolveMediaRef.mockReturnValue({ url: 'banner-id' });

    const res = await request(app).get('/ap/users/alice').set('Accept', AP_ACCEPT).expect(200);

    expect('image' in res.body).toBe(false);
  });
});

describe('GET /ap/users/:username/outbox?page=true — reuses buildCreateNoteActivity', () => {
  beforeEach(() => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: ALICE });
    mocks.buildCreateNoteActivity.mockImplementation((post: PostRecord) => ({
      type: 'Create',
      object: { id: `https://mention.earth/ap/users/alice/posts/${post.id}` },
    }));
  });

  it('maps each post through buildCreateNoteActivity into orderedItems', async () => {
    const older = await alicePost();
    const newer = await alicePost();

    const res = await request(app)
      .get('/ap/users/alice/outbox?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledTimes(2);
    // The outbox passes NO reply context and the per-post mention + poll + quote
    // contexts (all undefined here — the batch resolvers returned empty maps) as
    // args 3-6.
    expect(mocks.buildCreateNoteActivity).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: newer.id }),
      'alice',
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(res.body.type).toBe('OrderedCollectionPage');
    // Newest first, and the ids are the ones actually stored.
    expect(res.body.orderedItems.map((item: { object: { id: string } }) => item.object.id)).toEqual([
      `https://mention.earth/ap/users/alice/posts/${newer.id}`,
      `https://mention.earth/ap/users/alice/posts/${older.id}`,
    ]);
    expect(res.body.totalItems).toBe(2);
    // A page that does not overfetch past the window has no further page.
    expect(res.body.next).toBeUndefined();
  });

  it('publishes only PUBLIC, PUBLISHED, non-reply posts owned by the named user', async () => {
    const published = await alicePost();
    await alicePost({ visibility: PostVisibility.PRIVATE });
    await alicePost({ visibility: PostVisibility.FOLLOWERS_ONLY });
    await alicePost({ status: 'draft' });
    await alicePost({ oxyUserId: scope.user('mallory') });
    await alicePost({ parentPostId: published.id, isReply: true });

    const res = await request(app)
      .get('/ap/users/alice/outbox?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    expect(res.body.orderedItems.map((item: { object: { id: string } }) => item.object.id)).toEqual([
      `https://mention.earth/ap/users/alice/posts/${published.id}`,
    ]);
  });

  it('never publishes an ORPHANED REPLY as a top-level Note', async () => {
    // `parent_post_id` is `ON DELETE SET NULL`, so deleting the parent leaves a
    // reply whose parent id is NULL while `is_reply` stays true. Scoping the
    // outbox on `parent_post_id IS NULL` — the literal translation of the Mongo
    // filter — publishes it to the fediverse as if the author had posted it on
    // its own. `is_reply = false` is what prevents that, and this is the only
    // test that can tell the two predicates apart.
    const parent = await alicePost();
    const reply = await alicePost({ parentPostId: parent.id, isReply: true });
    await getDb().delete(posts).where(eq(posts.id, parent.id));

    const res = await request(app)
      .get('/ap/users/alice/outbox?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    const [orphan] = await getDb()
      .select({ parentPostId: posts.parentPostId, isReply: posts.isReply })
      .from(posts)
      .where(eq(posts.id, reply.id));
    // The premise, asserted rather than assumed: without this the test could
    // pass because the cascade removed the reply outright.
    expect(orphan).toEqual({ parentPostId: null, isReply: true });
    expect(res.body.orderedItems).toEqual([]);
    expect(res.body.totalItems).toBe(0);
  });

  it('threads the resolved poll context into the builder so a poll post serializes as a Question', async () => {
    const pollPost = await alicePost();
    const pollContext = {
      multiple: false,
      options: [{ name: 'A', votes: 1 }],
      endTime: new Date('2099-01-01T00:00:00.000Z'),
      closed: false,
      votersCount: 1,
    };
    mocks.resolvePollContextByPost.mockResolvedValue(new Map([[pollPost.id, pollContext]]));
    mocks.buildCreateNoteActivity.mockImplementation(
      (_post: unknown, _username: unknown, _reply: unknown, _mentions: unknown, poll: unknown) => ({
        type: 'Create',
        object: poll ? { type: 'Question' } : { type: 'Note' },
      }),
    );

    const res = await request(app)
      .get('/ap/users/alice/outbox?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    // The batch-resolved poll context is passed as the 5th arg for its post (the
    // 6th quote arg is undefined — no quote resolved for this post).
    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: pollPost.id }),
      'alice',
      undefined,
      undefined,
      pollContext,
      undefined,
    );
    expect(res.body.orderedItems).toEqual([{ type: 'Create', object: { type: 'Question' } }]);
  });

  it('threads the resolved quote context into the builder as the 6th arg for a quote post', async () => {
    const quotePost = await alicePost();
    const quoteContext = { uri: 'https://remote.example/users/bob/statuses/99' };
    mocks.resolveQuoteContextByPost.mockResolvedValue(new Map([[quotePost.id, quoteContext]]));

    await request(app).get('/ap/users/alice/outbox?page=true').set('Accept', AP_ACCEPT).expect(200);

    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: quotePost.id }),
      'alice',
      undefined,
      undefined,
      undefined,
      quoteContext,
    );
  });
});

describe('GET /ap/users/:username/outbox?page=true — keyset pagination', () => {
  beforeEach(() => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: ALICE });
    mocks.buildCreateNoteActivity.mockImplementation((post: PostRecord) => ({
      type: 'Create',
      object: { id: post.id },
    }));
  });

  it('walks every post across pages, newest first, with no repeat and no gap', async () => {
    // 25 > the 20-post window, so the first page overfetches, trims, and emits a
    // `next`. Walking it has to reach the 5 the old handler stranded.
    const created: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      created.push((await alicePost()).id);
    }
    const newestFirst = [...created].reverse();

    const seen: string[] = [];
    let url: string | undefined = '/ap/users/alice/outbox?page=true';
    let guard = 0;
    while (url) {
      const res = await request(app).get(url).set('Accept', AP_ACCEPT).expect(200);
      seen.push(...res.body.orderedItems.map((item: { object: { id: string } }) => item.object.id));
      expect(res.body.totalItems).toBe(25);
      const next: string | undefined = res.body.next;
      url = next ? next.replace('https://mention.earth', '') : undefined;
      if ((guard += 1) > 5) throw new Error('pagination did not terminate');
    }

    expect(seen).toEqual(newestFirst);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('emits exactly one window plus a cursor keyed on the LAST item of that window', async () => {
    for (let index = 0; index < 21; index += 1) await alicePost();

    const res = await request(app)
      .get('/ap/users/alice/outbox?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    // Only the window is serialized, not the overfetched probe row.
    expect(res.body.orderedItems).toHaveLength(20);
    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledTimes(20);
    expect(res.body.next).toContain('/ap/users/alice/outbox?page=true&cursor=');

    const lastServed = res.body.orderedItems[19].object.id as string;
    const cursorValue = decodeURIComponent(new URL(res.body.next).searchParams.get('cursor') ?? '');
    // The cursor's id half is the id as STORED — a uuid v7 for a post created
    // after the cutover. Deriving it from an ObjectId, or validating it as one,
    // strands the whole corpus behind page 1.
    expect(cursorValue.endsWith(`:${lastServed}`)).toBe(true);
  });

  it('self-references the cursor in the page id and stops when the page is short', async () => {
    for (let index = 0; index < 21; index += 1) await alicePost();

    const first = await request(app)
      .get('/ap/users/alice/outbox?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);
    const cursor = new URL(first.body.next).searchParams.get('cursor') ?? '';

    const second = await request(app)
      .get(`/ap/users/alice/outbox?page=true&cursor=${encodeURIComponent(cursor)}`)
      .set('Accept', AP_ACCEPT)
      .expect(200);

    expect(second.body.orderedItems).toHaveLength(1);
    expect(second.body.next).toBeUndefined();
    expect(second.body.id).toContain(`cursor=${encodeURIComponent(cursor)}`);
  });

  it('serves the first page for a malformed cursor rather than 500ing', async () => {
    // The cursor is client-supplied and reaches a `text` column and a timestamp
    // parse. An unparseable one must degrade to "no keyset bound", which is what
    // a remote server retrying with a stale or truncated cursor looks like.
    const post = await alicePost();

    const res = await request(app)
      .get('/ap/users/alice/outbox?page=true&cursor=not-a-cursor')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    expect(res.body.orderedItems.map((item: { object: { id: string } }) => item.object.id)).toEqual([
      post.id,
    ]);
  });
});

describe('GET /ap/users/:username/collections/featured — pinned posts', () => {
  beforeEach(() => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: ALICE });
    mocks.buildCreateNoteActivity.mockImplementation((post: PostRecord) => ({
      '@context': AP_CONTEXT,
      type: 'Create',
      object: { id: `https://mention.earth/ap/users/alice/posts/${post.id}`, type: 'Note' },
    }));
  });

  it("returns an OrderedCollection of bare Note objects for the user's pinned posts", async () => {
    const pinnedOlder = await alicePost({ metadata: { isPinned: true } });
    const pinnedNewer = await alicePost({ metadata: { isPinned: true } });
    // Everything the featured query must exclude, one row each.
    await alicePost();
    await alicePost({ metadata: { isPinned: true }, visibility: PostVisibility.PRIVATE });
    await alicePost({ metadata: { isPinned: true }, status: 'draft' });
    await alicePost({ metadata: { isPinned: true }, oxyUserId: scope.user('mallory') });
    await alicePost({ metadata: { isPinned: true }, parentPostId: pinnedOlder.id, isReply: true });

    const res = await request(app)
      .get('/ap/users/alice/collections/featured')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    // The collection is NOT paginated: inline orderedItems, no `first`.
    expect(res.body.type).toBe('OrderedCollection');
    expect(res.body.id).toBe('https://mention.earth/ap/users/alice/collections/featured');
    expect(res.body.totalItems).toBe(2);
    expect(res.body.first).toBeUndefined();
    // orderedItems are the BARE Note objects (Create envelope unwrapped), NOT
    // Create activities.
    expect(res.body.orderedItems).toEqual([
      { id: `https://mention.earth/ap/users/alice/posts/${pinnedNewer.id}`, type: 'Note' },
      { id: `https://mention.earth/ap/users/alice/posts/${pinnedOlder.id}`, type: 'Note' },
    ]);
  });

  it('returns an empty OrderedCollection when the user has no pinned posts', async () => {
    await alicePost();

    const res = await request(app)
      .get('/ap/users/alice/collections/featured')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    expect(res.body.type).toBe('OrderedCollection');
    expect(res.body.totalItems).toBe(0);
    expect(res.body.orderedItems).toEqual([]);
    expect(mocks.buildCreateNoteActivity).not.toHaveBeenCalled();
  });

  it('404s an unknown user', async () => {
    mocks.resolveOxyUser.mockResolvedValue(null);
    await request(app).get('/ap/users/ghost/collections/featured').set('Accept', AP_ACCEPT).expect(404);
    expect(mocks.buildCreateNoteActivity).not.toHaveBeenCalled();
  });
});

describe('GET /ap/users/:username/followers — Oxy follow graph (local + federated)', () => {
  beforeEach(() => {
    // The resolved profile carries the TRUE Oxy follow count as `_count`.
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1', _count: { followers: 3, following: 0 } });
  });

  it('summary advertises the true Oxy count as totalItems + a first page link, without hitting the graph list', async () => {
    const res = await request(app).get('/ap/users/alice/followers').set('Accept', AP_ACCEPT).expect(200);

    expect(res.body.type).toBe('OrderedCollection');
    expect(res.body.id).toBe('https://mention.earth/ap/users/alice/followers');
    // totalItems is the Oxy `_count.followers` (local + bridged federated edges),
    // NOT the old FederatedFollow-only remote count.
    expect(res.body.totalItems).toBe(3);
    expect(res.body.first).toBe('https://mention.earth/ap/users/alice/followers?page=true');
    // The summary uses the already-resolved `_count`, so it never lists members.
    expect(mocks.getUserFollowers).not.toHaveBeenCalled();
  });

  it('summary falls back to a graph list total when the resolved profile omits `_count`', async () => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1' }); // no `_count` (rare resolution fallback)
    mocks.getUserFollowers.mockResolvedValue({ followers: [], total: 9, hasMore: false });

    const res = await request(app).get('/ap/users/alice/followers').set('Accept', AP_ACCEPT).expect(200);

    // A minimal (limit 1) graph call resolves the authoritative total.
    expect(mocks.getUserFollowers).toHaveBeenCalledWith('u1', { limit: 1, offset: 0 });
    expect(res.body.totalItems).toBe(9);
  });

  it('page maps a MIX of local + federated followers to the right actor URIs, totalItems from the Oxy count', async () => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1', _count: { followers: 42 } });
    mocks.getUserFollowers.mockResolvedValue({
      followers: [
        // Local Mention user → our own minted actor URL.
        { id: 'a', username: 'bob', type: 'local' },
        // Federated user → the remote actorUri from the Oxy `federation` field.
        {
          id: 'b',
          username: 'carol@remote.example',
          type: 'federated',
          isFederated: true,
          federation: { actorUri: 'https://remote.example/users/carol' },
        },
      ],
      total: 42,
      hasMore: true,
    });

    const res = await request(app)
      .get('/ap/users/alice/followers?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    // First page pulls FOLLOW_PAGE_SIZE (20) at offset 0 from the Oxy graph.
    expect(mocks.getUserFollowers).toHaveBeenCalledWith('u1', { limit: 20, offset: 0 });
    expect(res.body.type).toBe('OrderedCollectionPage');
    expect(res.body.partOf).toBe('https://mention.earth/ap/users/alice/followers');
    expect(res.body.totalItems).toBe(42);
    // Local → https://<domain>/ap/users/<username>; federated → remote actorUri.
    expect(res.body.orderedItems).toEqual([
      'https://mention.earth/ap/users/bob',
      'https://remote.example/users/carol',
    ]);
    // `hasMore` from the Oxy list drives an offset-based `next`.
    expect(res.body.next).toBe('https://mention.earth/ap/users/alice/followers?page=true&offset=20');
  });

  it('follows an `offset` param into the graph query and self-references the page id, no `next` when the graph reports no more', async () => {
    mocks.getUserFollowers.mockResolvedValue({
      followers: [{ id: 'c', username: 'dave', type: 'local' }],
      total: 21,
      hasMore: false,
    });

    const res = await request(app)
      .get('/ap/users/alice/followers?page=true&offset=20')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    expect(mocks.getUserFollowers).toHaveBeenCalledWith('u1', { limit: 20, offset: 20 });
    expect(res.body.id).toBe('https://mention.earth/ap/users/alice/followers?page=true&offset=20');
    expect(res.body.orderedItems).toEqual(['https://mention.earth/ap/users/dave']);
    expect(res.body.next).toBeUndefined();
  });

  it('skips members that cannot be mapped to an actor URI (never emits a raw id)', async () => {
    mocks.getUserFollowers.mockResolvedValue({
      followers: [
        { id: 'a', username: 'bob', type: 'local' },
        // Federated but no known actorUri → unmappable, skipped.
        { id: 'b', username: 'ghost@remote.example', type: 'federated', isFederated: true },
        // Local but no username → unmappable, skipped.
        { id: 'c', type: 'local' },
      ],
      total: 3,
      hasMore: false,
    });

    const res = await request(app).get('/ap/users/alice/followers?page=true').set('Accept', AP_ACCEPT).expect(200);

    expect(res.body.orderedItems).toEqual(['https://mention.earth/ap/users/bob']);
  });

  it('fails soft: an Oxy graph outage on the page yields an empty page (no 500), totalItems from `_count`', async () => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1', _count: { followers: 5 } });
    mocks.getUserFollowers.mockRejectedValue(new Error('oxy down'));

    const res = await request(app).get('/ap/users/alice/followers?page=true').set('Accept', AP_ACCEPT).expect(200);

    expect(res.body.type).toBe('OrderedCollectionPage');
    expect(res.body.orderedItems).toEqual([]);
    expect(res.body.totalItems).toBe(5);
    expect(res.body.next).toBeUndefined();
  });

  it('404s an unknown user', async () => {
    mocks.resolveOxyUser.mockResolvedValue(null);
    await request(app).get('/ap/users/ghost/followers').set('Accept', AP_ACCEPT).expect(404);
    expect(mocks.getUserFollowers).not.toHaveBeenCalled();
  });
});

describe('GET /ap/users/:username/following — Oxy follow graph (local + federated)', () => {
  beforeEach(() => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1', _count: { followers: 0, following: 5 } });
  });

  it('summary advertises the true Oxy following count + a first page link', async () => {
    const res = await request(app).get('/ap/users/alice/following').set('Accept', AP_ACCEPT).expect(200);

    expect(res.body.type).toBe('OrderedCollection');
    expect(res.body.first).toBe('https://mention.earth/ap/users/alice/following?page=true');
    expect(res.body.totalItems).toBe(5);
    expect(mocks.getUserFollowing).not.toHaveBeenCalled();
  });

  it('page maps the OUTBOUND graph members (local + federated) to actor URIs', async () => {
    mocks.getUserFollowing.mockResolvedValue({
      following: [
        { id: 'x', username: 'erin', type: 'local' },
        {
          id: 'y',
          username: 'frank@remote.example',
          type: 'federated',
          isFederated: true,
          federation: { actorUri: 'https://remote.example/users/frank' },
        },
      ],
      total: 2,
      hasMore: false,
    });

    const res = await request(app)
      .get('/ap/users/alice/following?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    expect(mocks.getUserFollowing).toHaveBeenCalledWith('u1', { limit: 20, offset: 0 });
    expect(res.body.type).toBe('OrderedCollectionPage');
    expect(res.body.partOf).toBe('https://mention.earth/ap/users/alice/following');
    expect(res.body.totalItems).toBe(2);
    expect(res.body.orderedItems).toEqual([
      'https://mention.earth/ap/users/erin',
      'https://remote.example/users/frank',
    ]);
    expect(res.body.next).toBeUndefined();
  });
});

describe('GET /ap/users/:username/posts/:id — dereference', () => {
  beforeEach(() => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: ALICE });
  });

  function noteFor(post: PostRecord) {
    return {
      id: `https://mention.earth/ap/users/alice/posts/${post.id}`,
      type: 'Note',
      attributedTo: 'https://mention.earth/ap/users/alice',
      content: 'hello',
    };
  }

  function stubBuilder(post: PostRecord) {
    mocks.buildCreateNoteActivity.mockReturnValue({
      '@context': ['https://www.w3.org/ns/activitystreams'],
      type: 'Create',
      object: noteFor(post),
    });
  }

  it('returns the AP Note (with its own @context) for a public published post', async () => {
    const post = await alicePost();
    stubBuilder(post);

    const res = await request(app)
      .get(`/ap/users/alice/posts/${post.id}`)
      .set('Accept', AP_ACCEPT)
      .expect(200);

    expect(res.body).toEqual({ '@context': AP_CONTEXT, ...noteFor(post) });
  });

  it('serves a post whose id is a uuid v7, which the removed ObjectId gate would have 404d', async () => {
    const post = await alicePost();
    stubBuilder(post);

    // The premise, asserted rather than assumed — a fixture that happened to
    // mint an ObjectId-shaped id would make this case vacuous.
    expect(post.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await request(app).get(`/ap/users/alice/posts/${post.id}`).set('Accept', AP_ACCEPT).expect(200);
  });

  it.each([
    ['private', { visibility: PostVisibility.PRIVATE }],
    ['followers-only', { visibility: PostVisibility.FOLLOWERS_ONLY }],
    ['unpublished', { status: 'draft' as const }],
  ])('404s a %s post', async (_label, overrides) => {
    const post = await alicePost(overrides);

    await request(app).get(`/ap/users/alice/posts/${post.id}`).set('Accept', AP_ACCEPT).expect(404);
    expect(mocks.buildCreateNoteActivity).not.toHaveBeenCalled();
  });

  it("404s a post owned by someone else, even though it is public and published", async () => {
    const post = await alicePost({ oxyUserId: scope.user('mallory') });

    await request(app).get(`/ap/users/alice/posts/${post.id}`).set('Accept', AP_ACCEPT).expect(404);
    expect(mocks.buildCreateNoteActivity).not.toHaveBeenCalled();
  });

  it('DOES serve a reply — a remote server asked for this exact Note by id', async () => {
    // Unlike the outbox, which must not publish a reply as a top-level Note.
    const parent = await alicePost();
    const reply = await alicePost({ parentPostId: parent.id, isReply: true });
    stubBuilder(reply);

    await request(app).get(`/ap/users/alice/posts/${reply.id}`).set('Accept', AP_ACCEPT).expect(200);
  });

  it('passes the resolved reply context into the Note builder for a reply post', async () => {
    const parent = await alicePost();
    const reply = await alicePost({ parentPostId: parent.id, isReply: true });
    stubBuilder(reply);
    const replyContext = {
      inReplyTo: 'https://remote.example/users/bob/statuses/9',
      mention: { href: 'https://remote.example/users/bob', name: '@bob@remote.example' },
    };
    mocks.resolveReplyContext.mockResolvedValue(replyContext);

    await request(app).get(`/ap/users/alice/posts/${reply.id}`).set('Accept', AP_ACCEPT).expect(200);

    // The route resolves the reply addressing from the SERVED row and threads it
    // into the pure Note builder as the third argument.
    expect(mocks.resolveReplyContext).toHaveBeenCalledWith(expect.objectContaining({ id: reply.id }));
    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: reply.id }),
      'alice',
      replyContext,
      undefined,
      undefined,
      undefined,
    );
  });

  it('passes the resolved quote context into the Note builder for a quote post', async () => {
    const quoted = await alicePost();
    const quotePost = await alicePost({ quoteOf: quoted.id });
    stubBuilder(quotePost);
    const quoteContext = { uri: 'https://remote.example/users/bob/statuses/99' };
    mocks.resolveQuoteContext.mockResolvedValue(quoteContext);

    await request(app)
      .get(`/ap/users/alice/posts/${quotePost.id}`)
      .set('Accept', AP_ACCEPT)
      .expect(200);

    expect(mocks.resolveQuoteContext).toHaveBeenCalledWith(
      expect.objectContaining({ id: quotePost.id }),
    );
    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledWith(
      expect.objectContaining({ id: quotePost.id }),
      'alice',
      undefined,
      undefined,
      undefined,
      quoteContext,
    );
  });

  it('404s an id that matches no row, without an id-shape guard', async () => {
    // `posts.id` is `text`, so an arbitrary path segment is a bound parameter
    // that matches nothing — a 404, not a cast error and not a 500.
    await request(app)
      .get('/ap/users/alice/posts/not-an-objectid')
      .set('Accept', AP_ACCEPT)
      .expect(404);
    expect(mocks.buildCreateNoteActivity).not.toHaveBeenCalled();
  });

  it('redirects a non-ActivityPub request to the on-site post URL', async () => {
    const res = await request(app)
      .get(`/ap/users/alice/posts/${VALID_ID}`)
      .set('Accept', 'text/html')
      .expect(302);
    expect(res.headers.location).toBe(`https://mention.earth/@alice/posts/${VALID_ID}`);
  });
});
