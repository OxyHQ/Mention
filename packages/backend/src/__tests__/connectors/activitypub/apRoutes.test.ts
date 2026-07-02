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
  userSettingsFindOne: vi.fn(),
  postFind: vi.fn(),
  postCountDocuments: vi.fn(),
  postFindOne: vi.fn(),
  resolveAvatarUrl: vi.fn(),
  resolveMediaRef: vi.fn(),
}));

vi.mock('express-rate-limit', () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../middleware/rateLimitStore', () => ({ RedisStore: class {} }));
vi.mock('../../../queue/producers', () => ({ enqueueInboxActivity: vi.fn() }));

vi.mock('../../../connectors/activitypub/ActivityPubConnector', () => ({
  activityPubConnector: {
    buildCreateNoteActivity: (...args: unknown[]) => mocks.buildCreateNoteActivity(...args),
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
  default: { countDocuments: vi.fn() },
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
