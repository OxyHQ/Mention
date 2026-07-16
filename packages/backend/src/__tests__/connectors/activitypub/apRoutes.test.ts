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
  userSettingsFindOne: vi.fn(),
  postFind: vi.fn(),
  postCountDocuments: vi.fn(),
  postFindOne: vi.fn(),
  resolveAvatarUrl: vi.fn(),
  resolveMediaRef: vi.fn(),
  followFind: vi.fn(),
  followCountDocuments: vi.fn(),
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

vi.mock('../../../models/FederatedFollow', () => ({
  default: {
    countDocuments: (...args: unknown[]) => mocks.followCountDocuments(...args),
    find: (...args: unknown[]) => mocks.followFind(...args),
  },
}));

import apRoutes from '../../../connectors/activitypub/routes/ap.routes';
import { AP_CONTEXT } from '../../../connectors/activitypub/constants';

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
  mocks.followCountDocuments.mockResolvedValue(0);
  // Default: not a reply (or unresolvable parent) — the dereference route serves
  // the Note with no `inReplyTo`. Individual tests override for a reply post.
  mocks.resolveReplyContext.mockResolvedValue(null);
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
    expect(mocks.buildCreateNoteActivity).toHaveBeenNthCalledWith(1, posts[0], 'alice');
    expect(res.body.type).toBe('OrderedCollectionPage');
    expect(res.body.orderedItems).toEqual([
      { type: 'Create', object: { id: 'https://mention.earth/ap/users/alice/posts/p1' } },
      { type: 'Create', object: { id: 'https://mention.earth/ap/users/alice/posts/p2' } },
    ]);
    // A page that does not overfetch past the window has no further page.
    expect(res.body.next).toBeUndefined();
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

describe('GET /ap/users/:username/followers — paginated collection', () => {
  beforeEach(() => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1' });
  });

  it('summary advertises totalItems AND a first page link so remotes can enumerate members', async () => {
    mocks.followCountDocuments.mockResolvedValue(3);

    const res = await request(app).get('/ap/users/alice/followers').set('Accept', AP_ACCEPT).expect(200);

    expect(res.body.type).toBe('OrderedCollection');
    expect(res.body.id).toBe('https://mention.earth/ap/users/alice/followers');
    expect(res.body.totalItems).toBe(3);
    expect(res.body.first).toBe('https://mention.earth/ap/users/alice/followers?page=true');
    // The summary must not enumerate rows — that is the page's job.
    expect(mocks.followFind).not.toHaveBeenCalled();
  });

  it('page enumerates the remote actor URIs and emits a `next` cursor when overflowing', async () => {
    mocks.followCountDocuments.mockResolvedValue(42);
    // Overfetch: the handler asks for PAGE_SIZE + 1 (21). Return 21 so it detects
    // a further page, trims to 20, and keys `next` on the 20th row.
    const rows = Array.from({ length: 21 }, (_, i) => ({
      _id: `f${i}`,
      remoteActorUri: `https://remote.example/users/u${i}`,
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
    }));
    const findSpy = vi.fn().mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => rows }) }),
    });
    mocks.followFind.mockImplementation((query: unknown) => findSpy(query));

    const res = await request(app)
      .get('/ap/users/alice/followers?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    // The query filters on inbound accepted edges for the resolved user.
    const query = findSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(query).toMatchObject({ localUserId: 'u1', direction: 'inbound', status: 'accepted' });

    expect(res.body.type).toBe('OrderedCollectionPage');
    expect(res.body.partOf).toBe('https://mention.earth/ap/users/alice/followers');
    expect(res.body.totalItems).toBe(42);
    // Only the window (20) is enumerated, as BARE remote actor URI strings.
    expect(res.body.orderedItems).toHaveLength(20);
    expect(res.body.orderedItems[0]).toBe('https://remote.example/users/u0');
    expect(res.body.orderedItems[19]).toBe('https://remote.example/users/u19');
    // `next` is a same-collection page cursor keyed on the last row of the window.
    expect(typeof res.body.next).toBe('string');
    expect(res.body.next).toContain('/ap/users/alice/followers?page=true&cursor=');
    const cursorValue = decodeURIComponent(new URL(res.body.next).searchParams.get('cursor') ?? '');
    expect(cursorValue).toBe(`${Date.UTC(2020, 0, 1, 0, 0, 19)}:f19`);
  });

  it('page has no `next` when the window is not overflowed', async () => {
    mocks.followCountDocuments.mockResolvedValue(2);
    const rows = [
      { _id: 'f1', remoteActorUri: 'https://remote.example/users/a', createdAt: new Date(Date.UTC(2020, 0, 1)).toISOString() },
      { _id: 'f2', remoteActorUri: 'https://remote.example/users/b', createdAt: new Date(Date.UTC(2020, 0, 2)).toISOString() },
    ];
    mocks.followFind.mockReturnValue({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) });

    const res = await request(app).get('/ap/users/alice/followers?page=true').set('Accept', AP_ACCEPT).expect(200);

    expect(res.body.orderedItems).toEqual([
      'https://remote.example/users/a',
      'https://remote.example/users/b',
    ]);
    expect(res.body.next).toBeUndefined();
  });

  it('404s an unknown user', async () => {
    mocks.resolveOxyUser.mockResolvedValue(null);
    await request(app).get('/ap/users/ghost/followers').set('Accept', AP_ACCEPT).expect(404);
    expect(mocks.followFind).not.toHaveBeenCalled();
  });
});

describe('GET /ap/users/:username/following — paginated collection', () => {
  beforeEach(() => {
    mocks.resolveOxyUser.mockResolvedValue({ _id: 'u1' });
  });

  it('summary advertises a first page link + totalItems', async () => {
    mocks.followCountDocuments.mockResolvedValue(5);

    const res = await request(app).get('/ap/users/alice/following').set('Accept', AP_ACCEPT).expect(200);

    expect(res.body.type).toBe('OrderedCollection');
    expect(res.body.first).toBe('https://mention.earth/ap/users/alice/following?page=true');
    expect(res.body.totalItems).toBe(5);
  });

  it('page enumerates the OUTBOUND target actor URIs', async () => {
    mocks.followCountDocuments.mockResolvedValue(1);
    const rows = [
      { _id: 'f1', remoteActorUri: 'https://remote.example/users/z', createdAt: new Date(Date.UTC(2021, 5, 1)).toISOString() },
    ];
    const findSpy = vi.fn().mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => rows }) }),
    });
    mocks.followFind.mockImplementation((query: unknown) => findSpy(query));

    const res = await request(app)
      .get('/ap/users/alice/following?page=true')
      .set('Accept', AP_ACCEPT)
      .expect(200);

    const query = findSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(query).toMatchObject({ localUserId: 'u1', direction: 'outbound', status: 'accepted' });
    expect(res.body.type).toBe('OrderedCollectionPage');
    expect(res.body.partOf).toBe('https://mention.earth/ap/users/alice/following');
    expect(res.body.orderedItems).toEqual(['https://remote.example/users/z']);
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
    expect(mocks.buildCreateNoteActivity).toHaveBeenCalledWith(replyDoc, 'alice', replyContext);
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
