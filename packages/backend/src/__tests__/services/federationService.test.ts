import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  signRequest: vi.fn(),
  actorFind: vi.fn(),
  actorFindOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  postFind: vi.fn(),
  postFindOne: vi.fn(),
  postFindById: vi.fn(),
  postUpdateOne: vi.fn(),
  postCreate: vi.fn(),
  postInsertMany: vi.fn(),
  postExists: vi.fn(),
  likeCreate: vi.fn(),
  likeFindOneAndDelete: vi.fn(),
  getServiceOxyClient: vi.fn(),
  makeServiceRequest: vi.fn(),
  persistRemoteMedia: vi.fn(),
  recordAccess: vi.fn(),
  postCreatorCreate: vi.fn(),
  followExists: vi.fn(),
  assertSafePublicUrl: vi.fn(),
  fetchUpstreamFollowingRedirects: vi.fn(),
  fetchUpstreamSingleHop: vi.fn(),
  userSettingsUpdateOne: vi.fn(),
  uploadProfileBanner: vi.fn(),
}));

vi.mock('../../utils/federation/crypto', () => ({
  getPublicKey: mocks.getPublicKey,
  signViaOxy: mocks.signViaOxy,
  signRequest: mocks.signRequest,
}));

vi.mock('../../models/FederatedActor', () => ({
  default: {
    findOne: mocks.actorFindOne,
    find: mocks.actorFind,
    findOneAndUpdate: mocks.findOneAndUpdate,
    updateOne: mocks.updateOne,
  },
}));

vi.mock('../../models/FederatedFollow', () => ({
  default: {
    exists: mocks.followExists,
  },
}));

vi.mock('../../utils/ssrfGuard', () => ({
  assertSafePublicUrl: mocks.assertSafePublicUrl,
}));

vi.mock('../../models/FederationDeliveryQueue', () => ({
  default: {},
  getNextRetryTime: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
  // Mirror the real module's `pending` constant so OutboxSyncService's Stage-A
  // baseline seed resolves it (vitest throws on undefined mock exports).
  POST_CLASSIFICATION_PENDING: 'pending',
  Post: {
    find: mocks.postFind,
    findOne: mocks.postFindOne,
    findById: mocks.postFindById,
    updateOne: mocks.postUpdateOne,
    exists: mocks.postExists,
    collection: {
      insertMany: mocks.postInsertMany,
    },
  },
}));

vi.mock('../../models/Like', () => ({
  default: {
    create: mocks.likeCreate,
    findOneAndDelete: mocks.likeFindOneAndDelete,
  },
}));

vi.mock('../../models/UserSettings', () => ({
  default: {
    updateOne: mocks.userSettingsUpdateOne,
  },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: mocks.getServiceOxyClient,
}));

vi.mock('../../utils/safeUpstreamFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/safeUpstreamFetch')>();
  return {
    ...actual,
    fetchUpstreamFollowingRedirects: mocks.fetchUpstreamFollowingRedirects,
    fetchUpstreamSingleHop: mocks.fetchUpstreamSingleHop,
  };
});

vi.mock('../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: mocks.persistRemoteMedia,
}));

vi.mock('../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: mocks.recordAccess,
}));

// The service registry breaks the FederationService <-> PostCreationService
// circular import. Stub the post-creator accessor so federated note/boost
// imports don't pull in the real PostCreationService graph.
vi.mock('../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

import { federationService } from '../../services/FederationService';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
    ...init,
  });
}

function createNoteActivity(id: string, actorUri = 'https://mastodon.social/users/alice') {
  return {
    id: `${actorUri}/statuses/${id}/activity`,
    type: 'Create',
    actor: actorUri,
    published: `2026-06-18T00:00:0${id}Z`,
    object: {
      id: `${actorUri}/statuses/${id}`,
      type: 'Note',
      attributedTo: actorUri,
      content: `<p>post ${id}</p>`,
      published: `2026-06-18T00:00:0${id}Z`,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/instance#main-key',
    publicKeyPem: 'public',
  });
  mocks.signViaOxy.mockResolvedValue('signature');
  mocks.signRequest.mockResolvedValue({
    Host: 'www.threads.net',
    Date: 'Thu, 18 Jun 2026 00:00:00 GMT',
    Signature: 'signature',
  });
  mocks.findOneAndUpdate.mockImplementation(async (_query, update) => ({
    _id: 'actor_1',
    ...update.$set,
  }));
  mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.actorFind.mockReturnValue({
    lean: vi.fn().mockResolvedValue([]),
  });
  mocks.actorFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(null),
  });
  mocks.postFind.mockReturnValue({
    lean: vi.fn().mockResolvedValue([]),
  });
  mocks.postFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(null),
  });
  mocks.postFindById.mockReturnValue({
    lean: vi.fn().mockResolvedValue(null),
  });
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.postInsertMany.mockResolvedValue({ insertedCount: 0 });
  mocks.postExists.mockResolvedValue(null);
  mocks.followExists.mockResolvedValue({ _id: 'follow_1' });
  mocks.assertSafePublicUrl.mockResolvedValue({ ok: true, ip: '93.184.216.34', family: 4 });
  mocks.likeCreate.mockResolvedValue({ _id: 'like_1' });
  mocks.likeFindOneAndDelete.mockReturnValue({
    lean: vi.fn().mockResolvedValue(null),
  });
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.makeServiceRequest.mockResolvedValue({ id: 'oxy_user_1' });
  mocks.uploadProfileBanner.mockResolvedValue({ file: { id: 'banner_file_1' } });
  mocks.userSettingsUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.fetchUpstreamFollowingRedirects.mockReset();
  // `signedFetch` is built on `fetchUpstreamSingleHop` (IP-pinned, no global
  // `fetch`). Adapt it to the per-test stubbed global `fetch` so existing tests
  // that assert on the `fetch(url, { headers })` shape keep exercising the real
  // signing/redirect logic — the only thing that changed is the transport.
  mocks.fetchUpstreamSingleHop.mockImplementation(
    async (url: string, options: { headers: Record<string, string> }) => {
      const res: Response = await (globalThis.fetch as typeof fetch)(url, { headers: options.headers });
      const bodyBuffer = Buffer.from(await res.arrayBuffer());
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const stream = new PassThrough();
      stream.end(bodyBuffer);
      return { response: stream, status: res.status, headers };
    },
  );
  mocks.getServiceOxyClient.mockReturnValue({
    makeServiceRequest: mocks.makeServiceRequest,
    uploadProfileBanner: mocks.uploadProfileBanner,
  });
});

describe('federationService.fetchRemoteActor', () => {
  it('preserves canonical www hostnames such as Threads actor URIs', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://www.threads.net/ap/users/mosseri/') {
        return jsonResponse({
          id: 'https://www.threads.net/ap/users/mosseri/',
          type: 'Person',
          preferredUsername: 'mosseri',
          name: 'Adam Mosseri',
          inbox: 'https://www.threads.net/ap/users/mosseri/inbox',
          outbox: 'https://www.threads.net/ap/users/mosseri/outbox',
          publicKey: {
            id: 'https://www.threads.net/ap/users/mosseri/#main-key',
            publicKeyPem: 'remote-public',
          },
        });
      }

      if (url === 'https://www.threads.net/ap/users/mosseri/outbox') {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 12 });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const actor = await federationService.fetchRemoteActor(
      'https://www.threads.net/ap/users/mosseri/',
      false,
      'mosseri@threads.net',
    );

    expect(actor?.uri).toBe('https://www.threads.net/ap/users/mosseri/');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.threads.net/ap/users/mosseri/',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: expect.stringContaining('application/activity+json'),
        }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('https://threads.net/ap/users/mosseri/'),
      expect.anything(),
    );
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { uri: 'https://www.threads.net/ap/users/mosseri/' },
      expect.objectContaining({
        $set: expect.objectContaining({
          uri: 'https://www.threads.net/ap/users/mosseri/',
          acct: 'mosseri@threads.net',
          domain: 'threads.net',
          outboxUrl: 'https://www.threads.net/ap/users/mosseri/outbox',
        }),
      }),
      expect.anything(),
    );
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith(
      'PUT',
      '/users/resolve',
      expect.objectContaining({
        username: 'mosseri@threads.net',
        actorUri: 'https://www.threads.net/ap/users/mosseri/',
        domain: 'threads.net',
      }),
    );
  });

  it('downloads actor banners through the SSRF-safe media fetcher with content validation and a size cap', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://remote.example/users/alice') {
        return jsonResponse({
          id: 'https://remote.example/users/alice',
          type: 'Person',
          preferredUsername: 'alice',
          name: 'Alice',
          inbox: 'https://remote.example/users/alice/inbox',
          image: ['http://127.0.0.1/latest/meta-data', { url: 'https://remote.example/banner.jpg' }],
        });
      }

      throw new Error(`unexpected global fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const body = new PassThrough();
    body.end(Buffer.from('fake-image-bytes'));
    Object.assign(body, {
      statusCode: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: body,
      finalUrl: 'http://127.0.0.1/latest/meta-data',
    });

    await federationService.fetchRemoteActor('https://remote.example/users/alice');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalledWith('http://127.0.0.1/latest/meta-data');
    expect(mocks.fetchUpstreamFollowingRedirects).toHaveBeenCalledWith(
      'http://127.0.0.1/latest/meta-data',
      {},
      expect.any(AbortSignal),
    );
    expect(mocks.uploadProfileBanner).toHaveBeenCalledTimes(1);
    expect(mocks.userSettingsUpdateOne).toHaveBeenCalledWith(
      { oxyUserId: 'oxy_user_1' },
      { $set: { profileHeaderImage: 'banner_file_1' } },
      { upsert: true },
    );
  });

  it('rejects non-image actor banner responses before upload', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://remote.example/users/bob') {
        return jsonResponse({
          id: 'https://remote.example/users/bob',
          type: 'Person',
          preferredUsername: 'bob',
          inbox: 'https://remote.example/users/bob/inbox',
          image: 'https://remote.example/banner.txt',
        });
      }

      throw new Error(`unexpected global fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const body = new PassThrough();
    body.end(Buffer.from('not an image'));
    Object.assign(body, {
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
    });
    mocks.fetchUpstreamFollowingRedirects.mockResolvedValue({
      response: body,
      finalUrl: 'https://remote.example/banner.txt',
    });

    await federationService.fetchRemoteActor('https://remote.example/users/bob');

    expect(mocks.fetchUpstreamFollowingRedirects).toHaveBeenCalledWith(
      'https://remote.example/banner.txt',
      {},
      expect.any(AbortSignal),
    );
    expect(mocks.uploadProfileBanner).not.toHaveBeenCalled();
    expect(mocks.userSettingsUpdateOne).not.toHaveBeenCalled();
  });

});

describe('federationService.syncOutboxPostsDetailed', () => {
  it('does not stamp cooldown for non-empty outboxes that expose no importable pages', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://www.threads.net/ap/users/mosseri/outbox/') {
        return jsonResponse({
          type: 'OrderedCollection',
          totalItems: 2169,
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await federationService.syncOutboxPostsDetailed({
      uri: 'https://www.threads.net/ap/users/mosseri/',
      acct: 'mosseri@threads.net',
      outboxUrl: 'https://www.threads.net/ap/users/mosseri/outbox/',
      oxyUserId: 'oxy_user_threads',
    });

    expect(result).toMatchObject({
      syncedCount: 0,
      shouldStampCooldown: false,
      reason: 'non-empty-outbox-without-items',
      candidateCount: 0,
      reachedEnd: false,
    });
  });

  it('returns a page cursor with item offset when a backfill batch stops mid-page', async () => {
    const outboxUrl = 'https://mastodon.social/users/alice/outbox';
    const firstPageUrl = 'https://mastodon.social/users/alice/outbox?page=true';
    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({
          type: 'OrderedCollection',
          totalItems: 3,
          first: firstPageUrl,
        });
      }
      if (url === firstPageUrl) {
        return jsonResponse({
          type: 'OrderedCollectionPage',
          id: firstPageUrl,
          next: 'https://mastodon.social/users/alice/outbox?max_id=3&page=true',
          orderedItems: [
            createNoteActivity('1'),
            createNoteActivity('2'),
            createNoteActivity('3'),
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await federationService.syncOutboxPostsDetailed(
      {
        uri: 'https://mastodon.social/users/alice',
        acct: 'alice@mastodon.social',
        outboxUrl,
        oxyUserId: 'oxy_user_alice',
      },
      { limit: 2, maxPages: 1 },
    );

    expect(result).toMatchObject({
      syncedCount: 2,
      shouldStampCooldown: true,
      candidateCount: 2,
      newPostCount: 2,
      nextCursor: { url: firstPageUrl, itemOffset: 2 },
      reachedEnd: false,
    });
    expect(mocks.postInsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ federation: expect.objectContaining({ activityId: 'https://mastodon.social/users/alice/statuses/1' }) }),
        expect.objectContaining({ federation: expect.objectContaining({ activityId: 'https://mastodon.social/users/alice/statuses/2' }) }),
      ]),
      { ordered: false },
    );
    // Each raw-inserted note carries its ORIGINAL AP `published` date as
    // createdAt/updatedAt (not the sync time), so feeds order by author time.
    const insertedNotes = mocks.postInsertMany.mock.calls[0][0] as Array<Record<string, unknown>>;
    const note1 = insertedNotes.find(
      (d) => (d.federation as { activityId?: string }).activityId === 'https://mastodon.social/users/alice/statuses/1',
    );
    expect(note1?.createdAt).toBeInstanceOf(Date);
    expect((note1?.createdAt as Date).toISOString()).toBe('2026-06-18T00:00:01.000Z');
    expect((note1?.updatedAt as Date).toISOString()).toBe('2026-06-18T00:00:01.000Z');
  });

  it('continues from a stored page cursor and offset', async () => {
    const outboxUrl = 'https://mastodon.social/users/alice/outbox';
    const firstPageUrl = 'https://mastodon.social/users/alice/outbox?page=true';
    const secondPageUrl = 'https://mastodon.social/users/alice/outbox?max_id=3&page=true';
    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({
          type: 'OrderedCollection',
          totalItems: 4,
          first: firstPageUrl,
        });
      }
      if (url === firstPageUrl) {
        return jsonResponse({
          type: 'OrderedCollectionPage',
          id: firstPageUrl,
          next: secondPageUrl,
          orderedItems: [
            createNoteActivity('1'),
            createNoteActivity('2'),
            createNoteActivity('3'),
          ],
        });
      }
      if (url === secondPageUrl) {
        return jsonResponse({
          type: 'OrderedCollectionPage',
          id: secondPageUrl,
          orderedItems: [
            createNoteActivity('4'),
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await federationService.syncOutboxPostsDetailed(
      {
        uri: 'https://mastodon.social/users/alice',
        acct: 'alice@mastodon.social',
        outboxUrl,
        oxyUserId: 'oxy_user_alice',
      },
      {
        limit: 2,
        maxPages: 2,
        startPageUrl: firstPageUrl,
        startItemOffset: 2,
      },
    );

    expect(result).toMatchObject({
      syncedCount: 2,
      shouldStampCooldown: true,
      candidateCount: 2,
      newPostCount: 2,
      reachedEnd: true,
    });
    expect(result.nextCursor).toBeUndefined();
    expect(mocks.postInsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ federation: expect.objectContaining({ activityId: 'https://mastodon.social/users/alice/statuses/3' }) }),
        expect.objectContaining({ federation: expect.objectContaining({ activityId: 'https://mastodon.social/users/alice/statuses/4' }) }),
      ]),
      { ordered: false },
    );
  });
});

/**
 * Make `getOrFetchActor`/`resolveActorOxyUserId` resolve a remote actor to a
 * fresh (non-stale) federated Oxy user so no background refresh fires.
 */
function stubResolvedActor(oxyUserId: string | null) {
  mocks.actorFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(
      oxyUserId
        ? { uri: 'https://mastodon.social/users/bob', oxyUserId, lastFetchedAt: new Date() }
        : null,
    ),
  });
}

/** Make `resolvePostIdFromObjectUri` resolve a remote object URI to a local id. */
function stubResolvedPost(localId: string | null) {
  mocks.postFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue(localId ? { _id: localId } : null),
  });
}

describe('federationService.processInboxActivity → handleLike', () => {
  const objectUri = 'https://mastodon.social/users/alice/statuses/100';
  const actorUri = 'https://mastodon.social/users/bob';

  it('records a native Like and increments the counter in lockstep', async () => {
    stubResolvedActor('oxy_bob');
    stubResolvedPost('local_post_1');

    await federationService.processInboxActivity(
      { type: 'Like', actor: actorUri, object: objectUri },
      actorUri,
    );

    expect(mocks.likeCreate).toHaveBeenCalledWith({ userId: 'oxy_bob', postId: 'local_post_1', value: 1 });
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: 'local_post_1' },
      { $inc: { 'stats.likesCount': 1 } },
    );
  });

  it('is a no-op when the booster cannot be resolved to an Oxy user', async () => {
    stubResolvedActor(null);
    stubResolvedPost('local_post_1');

    await federationService.processInboxActivity(
      { type: 'Like', actor: actorUri, object: objectUri },
      actorUri,
    );

    expect(mocks.likeCreate).not.toHaveBeenCalled();
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });

  it('does not move the counter when a redelivered Like hits the unique index', async () => {
    stubResolvedActor('oxy_bob');
    stubResolvedPost('local_post_1');
    mocks.likeCreate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));

    await federationService.processInboxActivity(
      { type: 'Like', actor: actorUri, object: objectUri },
      actorUri,
    );

    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });
});

describe('federationService.processInboxActivity → handleUndoLike', () => {
  const objectUri = 'https://mastodon.social/users/alice/statuses/100';
  const actorUri = 'https://mastodon.social/users/bob';

  it('deletes the Like and decrements the counter when a record existed', async () => {
    stubResolvedActor('oxy_bob');
    stubResolvedPost('local_post_1');
    mocks.likeFindOneAndDelete.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'like_1' }),
    });

    await federationService.processInboxActivity(
      { type: 'Undo', actor: actorUri, object: { type: 'Like', object: objectUri } },
      actorUri,
    );

    expect(mocks.likeFindOneAndDelete).toHaveBeenCalledWith({ userId: 'oxy_bob', postId: 'local_post_1', value: 1 });
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: 'local_post_1', 'stats.likesCount': { $gt: 0 } },
      { $inc: { 'stats.likesCount': -1 } },
    );
  });

  it('does not decrement when no Like record was deleted', async () => {
    stubResolvedActor('oxy_bob');
    stubResolvedPost('local_post_1');
    mocks.likeFindOneAndDelete.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });

    await federationService.processInboxActivity(
      { type: 'Undo', actor: actorUri, object: { type: 'Like', object: objectUri } },
      actorUri,
    );

    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });
});

describe('federationService.processInboxActivity → handleAnnounce', () => {
  const announcedUri = 'https://mastodon.social/users/alice/statuses/200';
  const actorUri = 'https://mastodon.social/users/bob';
  const announceId = 'https://mastodon.social/users/bob/statuses/200/activity';

  it('creates a native boost Post deduped by Announce id and increments boostsCount', async () => {
    stubResolvedActor('oxy_bob');
    stubResolvedPost('local_post_2');
    // The boosted post must be public + published for the boost to be imported.
    mocks.postFindById.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ status: 'published', visibility: 'public' }),
    });
    mocks.postExists.mockResolvedValue(null); // no existing boost

    await federationService.processInboxActivity(
      {
        type: 'Announce',
        id: announceId,
        actor: actorUri,
        object: announcedUri,
        published: '2026-06-18T09:30:00Z',
      },
      actorUri,
    );

    expect(mocks.postExists).toHaveBeenCalledWith({ 'federation.activityId': announceId });
    expect(mocks.postCreatorCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        oxyUserId: 'oxy_bob',
        boostOf: 'local_post_2',
        federation: expect.objectContaining({ activityId: announceId }),
        // The boost Post's date reflects when the boost (Announce) happened.
        createdAt: new Date('2026-06-18T09:30:00Z'),
        updatedAt: new Date('2026-06-18T09:30:00Z'),
      }),
    );
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: 'local_post_2' },
      { $inc: { 'stats.boostsCount': 1 } },
    );
  });

  it('skips when the booster is unresolved (no record, no counter move)', async () => {
    stubResolvedActor(null);

    await federationService.processInboxActivity(
      { type: 'Announce', id: announceId, actor: actorUri, object: announcedUri },
      actorUri,
    );

    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });

  it('does not double-create when the Announce was already imported', async () => {
    stubResolvedActor('oxy_bob');
    stubResolvedPost('local_post_2');
    mocks.postExists.mockResolvedValue({ _id: 'existing_boost' });

    await federationService.processInboxActivity(
      { type: 'Announce', id: announceId, actor: actorUri, object: announcedUri },
      actorUri,
    );

    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });

  it('blocks unsafe boosted object fetches before contacting the network', async () => {
    const unsafeUri = 'http://127.0.0.1/latest/meta-data';
    stubResolvedActor('oxy_bob');
    mocks.postFindOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    });
    mocks.postExists.mockResolvedValue(null);
    mocks.assertSafePublicUrl.mockImplementation(async (url: string) => (
      url === unsafeUri
        ? { ok: false, reason: 'literal ip in blocked range' }
        : { ok: true, ip: '93.184.216.34', family: 4 }
    ));
    const fetchMock = vi.fn(async () => jsonResponse({ type: 'Note' }));
    vi.stubGlobal('fetch', fetchMock);

    await federationService.processInboxActivity(
      { type: 'Announce', id: announceId, actor: actorUri, object: unsafeUri },
      actorUri,
    );

    expect(mocks.assertSafePublicUrl).toHaveBeenCalledWith(unsafeUri);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });
});

describe('federationService.processInboxActivity → handleCreate', () => {
  const actorUri = 'https://mastodon.social/users/bob';
  const noteId = 'https://mastodon.social/users/bob/statuses/300';
  const activityId = 'https://mastodon.social/users/bob/statuses/300/activity';

  function createActivity(notePublished?: string, activityPublished?: string) {
    const object: Record<string, unknown> = {
      id: noteId,
      type: 'Note',
      attributedTo: actorUri,
      content: '<p>hello from the past</p>',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    };
    if (notePublished) object.published = notePublished;
    const activity: Record<string, unknown> = { type: 'Create', id: activityId, actor: actorUri, object };
    if (activityPublished) activity.published = activityPublished;
    return activity;
  }

  it('stores the ORIGINAL Note published date as the post createdAt (not sync time)', async () => {
    stubResolvedActor('oxy_bob');
    mocks.postExists.mockResolvedValue(null); // not a duplicate

    await federationService.processInboxActivity(
      createActivity('2022-03-10T14:00:00Z'),
      actorUri,
    );

    expect(mocks.postCreatorCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        federation: expect.objectContaining({ activityId: noteId }),
        createdAt: new Date('2022-03-10T14:00:00Z'),
        updatedAt: new Date('2022-03-10T14:00:00Z'),
      }),
    );
  });

  it('falls back to the Create activity published when the Note omits one', async () => {
    stubResolvedActor('oxy_bob');
    mocks.postExists.mockResolvedValue(null);

    await federationService.processInboxActivity(
      createActivity(undefined, '2021-12-01T00:00:00Z'),
      actorUri,
    );

    expect(mocks.postCreatorCreate).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: new Date('2021-12-01T00:00:00Z') }),
    );
  });

  it('omits createdAt (schema default = now) when no valid published date is present', async () => {
    stubResolvedActor('oxy_bob');
    mocks.postExists.mockResolvedValue(null);

    await federationService.processInboxActivity(createActivity(), actorUri);

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    const params = mocks.postCreatorCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('createdAt');
    expect(params).not.toHaveProperty('updatedAt');
  });
});

describe('federationService media-cache fallback during outbox backfill', () => {
  const outboxUrl = 'https://mastodon.social/users/carol/outbox';
  const firstPageUrl = 'https://mastodon.social/users/carol/outbox?page=true';

  function noteWithImage(id: string, imageUrl: string) {
    const actorUri = 'https://mastodon.social/users/carol';
    return {
      id: `${actorUri}/statuses/${id}/activity`,
      type: 'Create',
      actor: actorUri,
      published: `2026-06-18T00:00:0${id}Z`,
      object: {
        id: `${actorUri}/statuses/${id}`,
        type: 'Note',
        attributedTo: actorUri,
        content: `<p>post ${id}</p>`,
        published: `2026-06-18T00:00:0${id}Z`,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        attachment: [{ type: 'Document', mediaType: 'image/jpeg', url: imageUrl }],
      },
    };
  }

  function stubOutbox(note: Record<string, unknown>) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 1, first: firstPageUrl });
      }
      if (url === firstPageUrl) {
        return jsonResponse({ type: 'OrderedCollectionPage', id: firstPageUrl, orderedItems: [note] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('keeps the original remote media item when the S3 cache write fails (soft)', async () => {
    stubOutbox(noteWithImage('1', 'https://cdn.mastodon.social/img1.jpg'));
    mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });

    await federationService.syncOutboxPostsDetailed(
      { uri: 'https://mastodon.social/users/carol', acct: 'carol@mastodon.social', outboxUrl, oxyUserId: 'oxy_carol' },
      { limit: 5, maxPages: 1 },
    );

    expect(mocks.persistRemoteMedia).toHaveBeenCalled();
    // Soft failure: the remote URL is queued for a later cache attempt and the
    // post is still stored with the original (un-rewritten) media id.
    expect(mocks.recordAccess).toHaveBeenCalledWith('https://cdn.mastodon.social/img1.jpg');
    expect(mocks.postInsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.objectContaining({
            media: expect.arrayContaining([
              expect.objectContaining({ id: 'https://cdn.mastodon.social/img1.jpg' }),
            ]),
          }),
        }),
      ]),
      { ordered: false },
    );
  });

  it('passes non-absolute media URLs through untouched (no cache attempt)', async () => {
    stubOutbox(noteWithImage('1', 'not-a-valid-url'));

    await federationService.syncOutboxPostsDetailed(
      { uri: 'https://mastodon.social/users/carol', acct: 'carol@mastodon.social', outboxUrl, oxyUserId: 'oxy_carol' },
      { limit: 5, maxPages: 1 },
    );

    expect(mocks.persistRemoteMedia).not.toHaveBeenCalled();
  });

  it('rewrites media to the cached Oxy file id on a successful cache write', async () => {
    stubOutbox(noteWithImage('1', 'https://cdn.mastodon.social/img1.jpg'));
    mocks.persistRemoteMedia.mockResolvedValue({
      ok: true,
      media: { oxyFileId: 'oxy_file_abc' },
    });

    await federationService.syncOutboxPostsDetailed(
      { uri: 'https://mastodon.social/users/carol', acct: 'carol@mastodon.social', outboxUrl, oxyUserId: 'oxy_carol' },
      { limit: 5, maxPages: 1 },
    );

    expect(mocks.postInsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.objectContaining({
            media: expect.arrayContaining([
              expect.objectContaining({ id: 'oxy_file_abc', cachedFromFederation: true }),
            ]),
          }),
        }),
      ]),
      { ordered: false },
    );
  });
});

describe('Stage-A baseline classification on federated outbox backfill', () => {
  const outboxUrl = 'https://chaos.social/users/dieter/outbox';
  const firstPageUrl = 'https://chaos.social/users/dieter/outbox?page=true';
  const actorUri = 'https://chaos.social/users/dieter';

  /** A German note on a .social instance carrying an explicit AP `language`. */
  function germanNote(id: string, language?: string, contentMap?: Record<string, string>) {
    const note: Record<string, unknown> = {
      id: `${actorUri}/statuses/${id}`,
      type: 'Note',
      attributedTo: actorUri,
      content: '<p>Guten Morgen zusammen, das ist ein ganz normaler deutscher Beitrag.</p>',
      published: `2026-06-18T00:00:0${id}Z`,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    };
    if (language) note.language = language;
    if (contentMap) note.contentMap = contentMap;
    return {
      id: `${actorUri}/statuses/${id}/activity`,
      type: 'Create',
      actor: actorUri,
      published: `2026-06-18T00:00:0${id}Z`,
      object: note,
    };
  }

  function stubOutbox(activity: Record<string, unknown>) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 1, first: firstPageUrl });
      }
      if (url === firstPageUrl) {
        return jsonResponse({ type: 'OrderedCollectionPage', id: firstPageUrl, orderedItems: [activity] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  /** The single doc handed to the raw `Post.collection.insertMany`. */
  function insertedDoc(): Record<string, unknown> {
    expect(mocks.postInsertMany).toHaveBeenCalledTimes(1);
    const docs = mocks.postInsertMany.mock.calls[0][0] as Record<string, unknown>[];
    expect(docs).toHaveLength(1);
    return docs[0];
  }

  it('captures the AP-declared language (not the "en" default) and the Stage-A baseline, keeping status pending', async () => {
    stubOutbox(germanNote('1', 'de-DE'));

    await federationService.syncOutboxPostsDetailed(
      { uri: actorUri, acct: 'dieter@chaos.social', outboxUrl, oxyUserId: 'oxy_dieter' },
      { limit: 5, maxPages: 1 },
    );

    const doc = insertedDoc();
    // Top-level language carries the REAL AP language, not the schema default 'en'.
    expect(doc.language).toBe('de');

    const classification = doc.postClassification as Record<string, unknown>;
    // Deterministic Stage-A fields are populated. The subdoc carries ONLY the
    // multi-language array; the primary lives on the top-level `post.language`.
    expect(classification.language).toBeUndefined();
    expect(classification.languages).toEqual(['de']);
    // chaos.social is a global .social instance → no region (not mislabeled DE).
    expect(classification.region).toBeUndefined();
    expect(classification.version).toBeGreaterThan(0);
    expect(classification.classifiedAt).toBeInstanceOf(Date);
    expect(Array.isArray(classification.hashtagsNorm)).toBe(true);
    // ...but status stays `pending` so the async AI batch still enriches it.
    expect(classification.status).toBe('pending');
    expect(classification.attempts).toBe(0);
  });

  it('falls back to the AP contentMap language when no top-level language is set', async () => {
    stubOutbox(germanNote('1', undefined, { de: '<p>Guten Morgen zusammen.</p>' }));

    await federationService.syncOutboxPostsDetailed(
      { uri: actorUri, acct: 'dieter@chaos.social', outboxUrl, oxyUserId: 'oxy_dieter' },
      { limit: 5, maxPages: 1 },
    );

    const doc = insertedDoc();
    expect(doc.language).toBe('de');
    const classification = doc.postClassification as Record<string, unknown>;
    expect(classification.language).toBeUndefined();
    expect(classification.languages).toEqual(['de']);
  });

  it('derives a coarse region from a ccTLD federated instance', async () => {
    const deOutboxUrl = 'https://social.example.de/users/dieter/outbox';
    const deFirstPageUrl = 'https://social.example.de/users/dieter/outbox?page=true';
    const deActorUri = 'https://social.example.de/users/dieter';
    const note = {
      id: `${deActorUri}/statuses/1/activity`,
      type: 'Create',
      actor: deActorUri,
      published: '2026-06-18T00:00:01Z',
      object: {
        id: `${deActorUri}/statuses/1`,
        type: 'Note',
        attributedTo: deActorUri,
        content: '<p>Guten Morgen zusammen, das ist ein deutscher Beitrag.</p>',
        language: 'de',
        published: '2026-06-18T00:00:01Z',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
      },
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === deOutboxUrl) {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 1, first: deFirstPageUrl });
      }
      if (url === deFirstPageUrl) {
        return jsonResponse({ type: 'OrderedCollectionPage', id: deFirstPageUrl, orderedItems: [note] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await federationService.syncOutboxPostsDetailed(
      { uri: deActorUri, acct: 'dieter@social.example.de', outboxUrl: deOutboxUrl, oxyUserId: 'oxy_dieter' },
      { limit: 5, maxPages: 1 },
    );

    const classification = insertedDoc().postClassification as Record<string, unknown>;
    expect(classification.region).toBe('DE');
  });
});
