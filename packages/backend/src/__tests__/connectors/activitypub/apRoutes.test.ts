import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract tests for the ActivityPub actor/outbox/dereference routes:
 *
 *  1. The actor JSON advertises the profile banner as AP `image` (Mastodon
 *     header) when the user has one, and omits it cleanly when absent.
 *  2. The outbox page reuses `activityPubConnector.buildCreateNoteActivity`
 *     (ONE Note builder shared with push delivery), not a hand-rolled mapping.
 *  3. A single post dereferences to its AP Note (200) only when PUBLIC +
 *     PUBLISHED and owned by the named user; otherwise 404.
 *
 * The heavy connector/crypto/model graph is stubbed so the router mounts in
 * isolation; `../constants` stays real (URL builders + Accept negotiation) with
 * only `resolveOxyUser` overridden.
 */

const AP_ACCEPT = 'application/activity+json';
const VALID_ID = '507f1f77bcf86cd799439011';

const mocks = vi.hoisted(() => ({
  resolveOxyUser: vi.fn(),
  getPublicKey: vi.fn(),
  buildCreateNoteActivity: vi.fn(),
  resolveReplyContext: vi.fn(),
  resolveMentionContext: vi.fn(),
  resolveMentionContextByPost: vi.fn(),
  resolvePollContext: vi.fn(),
  resolvePollContextByPost: vi.fn(),
  resolveQuoteContext: vi.fn(),
  resolveQuoteContextByPost: vi.fn(),
  userSettingsFindOne: vi.fn(),
  postFind: vi.fn(),
  postCountDocuments: vi.fn(),
  postFindOne: vi.fn(),
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

vi.mock('../../../connectors/activitypub/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../connectors/activitypub/constants')>();
  return { ...actual, resolveOxyUser: (...args: unknown[]) => mocks.resolveOxyUser(...args) };
});

vi.mock('../../../utils/mediaResolver', () => ({
  resolveAvatarUrl: (...args: unknown[]) => mocks.resolveAvatarUrl(...args),
  resolveMediaRef: (...args: unknown[]) => mocks.resolveMediaRef(...args),
}));

vi.mock('../../../models/Post', () => ({
  Post: {
    countDocuments: (...args: unknown[]) => mocks.postCountDocuments(...args),
    find: (...args: unknown[]) => mocks.postFind(...args),
    findOne: (...args: unknown[]) => mocks.postFindOne(...args),
  },
}));

vi.mock('../../../models/UserSettings', () => ({
  default: { findOne: (...args: unknown[]) => mocks.userSettingsFindOne(...args) },
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: (...args: unknown[]) => mocks.getServiceOxyClient(...args),
}));

import apRoutes from '../../../connectors/activitypub/routes/ap.routes';
import { AP_CONTEXT } from '@oxyhq/federation';

const app = express();
app.use(express.json());
app.use('/ap', apRoutes);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/alice#main-key',
    publicKeyPem: 'PEM',
  });
  mocks.resolveAvatarUrl.mockReturnValue(undefined);
  mocks.userSettingsFindOne.mockReturnValue({ lean: async () => null });
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
      _id: 'u1',
      name: { displayName: 'Alice' },
      avatar: null,
      createdAt: '2020-01-01T00:00:00.000Z',
    });
  });

  it('advertises the banner as AP image when the user has a profileHeaderImage', async () => {
    mocks.userSettingsFindOne.mockReturnValue({ lean: async () => ({ profileHeaderImage: 'banner-id' }) });
    mocks.resolveMediaRef.mockReturnValue({ url: 'https://cloud.oxy.so/banner-id' });

    const res = await request(app).get('/ap/users/alice').set('Accept', AP_ACCEPT).expect(200);

    expect(mocks.resolveMediaRef).toHaveBeenCalledWith('banner-id');
    expect(res.body.image).toEqual({ type: 'Image', url: 'https://cloud.oxy.so/banner-id' });
  });

  it('omits image when the user has no banner', async () => {
    mocks.userSettingsFindOne.mockReturnValue({ lean: async () => null });

    const res = await request(app).get('/ap/users/alice').set('Accept', AP_ACCEPT).expect(200);

    expect(res.body.image).toBeUndefined();
    expect('image' in res.body).toBe(false);
  });

  it('advertises the featured collection so Mastodon can fetch pinned posts on discovery', async () => {
    const res = await request(app).get('/ap/users/alice').set('Accept', AP_ACCEPT).expect(200);
    expect(res.body.featured).toBe('https://mention.earth/ap/users/alice/collections/featured');
  });

  it('omits image when the banner cannot resolve to an absolute URL', async () => {
    mocks.userSettingsFindOne.mockReturnValue({ lean: async () => ({ profileHeaderImage: 'banner-id' }) });
    // Degraded passthrough (unresolvable id) — not an absolute http(s) URL.
    mocks.resolveMediaRef.mockReturnValue({ url: 'banner-id' });

    const res = await request(app).get('/ap/users/alice').set('Accept', AP_ACCEPT).expect(200);

    expect('image' in res.body).toBe(false);
  });
});

describe('GET /ap/users/:username/outbox?page=true — reuses buildCreateNoteActivity', () => {
  it('maps each post through buildCreateNoteActivity into orderedItems', async () => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1' });
    mocks.postCountDocuments.mockResolvedValue(2);
    const posts = [{ _id: 'p1' }, { _id: 'p2' }];
    mocks.postFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => posts }) }),
    });
    mocks.buildCreateNoteActivity.mockImplementation((post: { _id: string }) => ({
      type: 'Create',
      object: { id: `https://mention.earth/ap/users/alice/posts/${post._id}` },
    }));

    const res = await request(app)
      .get('/ap/users/alice/outbox?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledTimes(2);
    // The outbox passes NO reply context and the per-post mention + poll + quote
    // contexts (all undefined here — the batch resolvers returned empty maps) as
    // args 3-6.
    expect(mocks.buildCreateNoteActivity).toHaveBeenNthCalledWith(1, posts[0], 'alice', undefined, undefined, undefined, undefined);
    expect(res.body.type).toBe('OrderedCollectionPage');
    expect(res.body.orderedItems).toEqual([
      { type: 'Create', object: { id: 'https://mention.earth/ap/users/alice/posts/p1' } },
      { type: 'Create', object: { id: 'https://mention.earth/ap/users/alice/posts/p2' } },
    ]);
    // A page that does not overfetch past the window has no further page.
    expect(res.body.next).toBeUndefined();
  });

  it('threads the resolved poll context into the builder so a poll post serializes as a Question', async () => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1' });
    mocks.postCountDocuments.mockResolvedValue(1);
    const posts = [{ _id: 'poll-post' }];
    mocks.postFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => posts }) }),
    });
    const pollContext = {
      multiple: false,
      options: [{ name: 'A', votes: 1 }],
      endTime: new Date('2099-01-01T00:00:00.000Z'),
      closed: false,
      votersCount: 1,
    };
    mocks.resolvePollContextByPost.mockResolvedValue(new Map([['poll-post', pollContext]]));
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
    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledWith(posts[0], 'alice', undefined, undefined, pollContext, undefined);
    expect(res.body.orderedItems).toEqual([{ type: 'Create', object: { type: 'Question' } }]);
  });

  it('threads the resolved quote context into the builder as the 6th arg for a quote post', async () => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1' });
    mocks.postCountDocuments.mockResolvedValue(1);
    const posts = [{ _id: 'quote-post' }];
    mocks.postFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => posts }) }),
    });
    const quoteContext = { uri: 'https://remote.example/users/bob/statuses/99' };
    mocks.resolveQuoteContextByPost.mockResolvedValue(new Map([['quote-post', quoteContext]]));
    mocks.buildCreateNoteActivity.mockImplementation(
      (post: { _id: string }) => ({ type: 'Create', object: { id: `x/${post._id}` } }),
    );

    await request(app).get('/ap/users/alice/outbox?page=true').set('Accept', AP_ACCEPT).expect(200);

    // The batch-resolved quote context is passed as the 6th arg for its post.
    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledWith(
      posts[0],
      'alice',
      undefined,
      undefined,
      undefined,
      quoteContext,
    );
  });
});

describe('GET /ap/users/:username/outbox?page=true — keyset pagination', () => {
  it('returns 20 items + a `next` cursor when more posts exist (fixes unreachable posts past page 1)', async () => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1' });
    mocks.postCountDocuments.mockResolvedValue(42);
    // Overfetch: the handler asks for PAGE_SIZE + 1 (21). Return 21 so it detects
    // a further page, trims to 20, and emits a `next` keyed on the 20th item.
    const posts = Array.from({ length: 21 }, (_, i) => ({
      _id: `p${i}`,
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
    }));
    mocks.postFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => posts }) }),
    });
    mocks.buildCreateNoteActivity.mockImplementation((post: { _id: string }) => ({
      type: 'Create',
      object: { id: `https://mention.earth/ap/users/alice/posts/${post._id}` },
    }));

    const res = await request(app)
      .get('/ap/users/alice/outbox?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    // Only the window is serialized, not the overfetched probe row.
    expect(res.body.orderedItems).toHaveLength(20);
    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledTimes(20);
    expect(res.body.totalItems).toBe(42);
    // `next` exists and is a same-collection page cursor — walking it reaches
    // the remaining 22 posts that the old handler stranded.
    expect(typeof res.body.next).toBe('string');
    expect(res.body.next).toContain('/ap/users/alice/outbox?page=true&cursor=');
    // The cursor is keyed on the LAST item of the window (p19), timestamp:id.
    const cursorValue = decodeURIComponent(new URL(res.body.next).searchParams.get('cursor') ?? '');
    expect(cursorValue).toBe(`${Date.UTC(2020, 0, 1, 0, 0, 19)}:p19`);
  });

  it('follows a `cursor` param into a keyset filter and self-references the page id', async () => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1' });
    mocks.postCountDocuments.mockResolvedValue(42);
    const posts = [
      { _id: 'p20', createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, 20)).toISOString() },
    ];
    const findSpy = vi.fn().mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => posts }) }),
    });
    mocks.postFind.mockImplementation((query: unknown) => findSpy(query));
    mocks.buildCreateNoteActivity.mockImplementation((post: { _id: string }) => ({
      type: 'Create',
      object: { id: `https://mention.earth/ap/users/alice/posts/${post._id}` },
    }));

    const cursor = `${Date.UTC(2020, 0, 1, 0, 0, 19)}:507f1f77bcf86cd799439011`;
    const res = await request(app)
      .get(`/ap/users/alice/outbox?page=true&cursor=${encodeURIComponent(cursor)}`)
      .set('Accept', AP_ACCEPT)
      .expect(200);

    // The keyset boundary is applied to the Mongo filter as an $or clause.
    const query = findSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(query.$or).toBeDefined();
    // No further page (1 item < window) → no `next`. The page id echoes the cursor.
    expect(res.body.next).toBeUndefined();
    expect(res.body.id).toContain(`cursor=${encodeURIComponent(cursor)}`);
  });
});

describe('GET /ap/users/:username/collections/featured — pinned posts', () => {
  it('returns an OrderedCollection of bare Note objects for the user\'s pinned posts', async () => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1' });
    const pinned = [{ _id: 'p1' }, { _id: 'p2' }];
    const findSpy = vi.fn().mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => pinned }) }),
    });
    mocks.postFind.mockImplementation((query: unknown) => findSpy(query));
    mocks.buildCreateNoteActivity.mockImplementation((post: { _id: string }) => ({
      '@context': AP_CONTEXT,
      type: 'Create',
      object: { id: `https://mention.earth/ap/users/alice/posts/${post._id}`, type: 'Note' },
    }));

    const res = await request(app)
      .get('/ap/users/alice/collections/featured')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    // Query filters on the pinned flag + the outbox's exact ownership/visibility.
    const query = findSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(query).toMatchObject({
      oxyUserId: 'u1',
      'metadata.isPinned': true,
      visibility: 'public',
      status: 'published',
      parentPostId: null,
    });

    // The collection is NOT paginated: inline orderedItems, no `first`.
    expect(res.body.type).toBe('OrderedCollection');
    expect(res.body.id).toBe('https://mention.earth/ap/users/alice/collections/featured');
    expect(res.body.totalItems).toBe(2);
    expect(res.body.first).toBeUndefined();
    // orderedItems are the BARE Note objects (Create envelope unwrapped), NOT
    // Create activities.
    expect(res.body.orderedItems).toEqual([
      { id: 'https://mention.earth/ap/users/alice/posts/p1', type: 'Note' },
      { id: 'https://mention.earth/ap/users/alice/posts/p2', type: 'Note' },
    ]);
  });

  it('returns an empty OrderedCollection when the user has no pinned posts', async () => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1' });
    mocks.postFind.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) });

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
    expect(mocks.postFind).not.toHaveBeenCalled();
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
  const NOTE = {
    id: 'https://mention.earth/ap/users/alice/posts/' + VALID_ID,
    type: 'Note',
    attributedTo: 'https://mention.earth/ap/users/alice',
    content: 'hello',
  };

  beforeEach(() => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1' });
    mocks.buildCreateNoteActivity.mockReturnValue({
      '@context': ['https://www.w3.org/ns/activitystreams'],
      type: 'Create',
      object: NOTE,
    });
  });

  it('returns the AP Note (with its own @context) for a public published post', async () => {
    mocks.postFindOne.mockReturnValue({ lean: async () => ({ _id: VALID_ID, content: { text: 'hello' } }) });

    const res = await request(app)
      .get(`/ap/users/alice/posts/${VALID_ID}`)
      .set('Accept', AP_ACCEPT)
      .expect(200);

    // Gating clause is exactly public + published + owned by the named user.
    expect(mocks.postFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: VALID_ID, oxyUserId: 'u1', visibility: 'public', status: 'published' }),
    );
    expect(res.body).toEqual({ '@context': AP_CONTEXT, ...NOTE });
  });

  it('404s when the post is not public/published/owned (query returns null)', async () => {
    mocks.postFindOne.mockReturnValue({ lean: async () => null });

    await request(app).get(`/ap/users/alice/posts/${VALID_ID}`).set('Accept', AP_ACCEPT).expect(404);
    expect(mocks.buildCreateNoteActivity).not.toHaveBeenCalled();
  });

  it('passes the resolved reply context into the Note builder for a reply post', async () => {
    const replyDoc = { _id: VALID_ID, content: { text: 'a reply' }, parentPostId: 'parent1' };
    mocks.postFindOne.mockReturnValue({ lean: async () => replyDoc });
    const replyContext = {
      inReplyTo: 'https://remote.example/users/bob/statuses/9',
      mention: { href: 'https://remote.example/users/bob', name: '@bob@remote.example' },
    };
    mocks.resolveReplyContext.mockResolvedValue(replyContext);

    await request(app).get(`/ap/users/alice/posts/${VALID_ID}`).set('Accept', AP_ACCEPT).expect(200);

    // The route resolves the reply addressing from the served post and threads it
    // into the pure Note builder as the third argument.
    expect(mocks.resolveReplyContext).toHaveBeenCalledWith(replyDoc);
    // The dereference route threads the resolved reply context + (null →) undefined
    // mention + poll + quote contexts into the Note builder.
    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledWith(replyDoc, 'alice', replyContext, undefined, undefined, undefined);
  });

  it('passes the resolved quote context into the Note builder for a quote post', async () => {
    const quoteDoc = { _id: VALID_ID, content: { text: 'quoting this' }, quoteOf: 'quoted-1' };
    mocks.postFindOne.mockReturnValue({ lean: async () => quoteDoc });
    const quoteContext = { uri: 'https://remote.example/users/bob/statuses/99' };
    mocks.resolveQuoteContext.mockResolvedValue(quoteContext);

    await request(app).get(`/ap/users/alice/posts/${VALID_ID}`).set('Accept', AP_ACCEPT).expect(200);

    // The route resolves the quote reference from the served post and threads it
    // into the pure Note builder as the sixth argument.
    expect(mocks.resolveQuoteContext).toHaveBeenCalledWith(quoteDoc);
    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledWith(
      quoteDoc,
      'alice',
      undefined,
      undefined,
      undefined,
      quoteContext,
    );
  });

  it('404s a malformed post id without touching the database', async () => {
    await request(app).get('/ap/users/alice/posts/not-an-objectid').set('Accept', AP_ACCEPT).expect(404);
    expect(mocks.resolveOxyUser).not.toHaveBeenCalled();
    expect(mocks.postFindOne).not.toHaveBeenCalled();
  });

  it('redirects a non-ActivityPub request to the on-site post URL', async () => {
    const res = await request(app).get(`/ap/users/alice/posts/${VALID_ID}`).set('Accept', 'text/html').expect(302);
    expect(res.headers.location).toBe(`https://mention.earth/@alice/posts/${VALID_ID}`);
  });
});
