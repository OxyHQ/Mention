import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getKeyPair: vi.fn(),
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
}));

vi.mock('../../utils/federation/crypto', () => ({
  getKeyPair: mocks.getKeyPair,
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
  default: {},
}));

vi.mock('../../models/FederationDeliveryQueue', () => ({
  default: {},
  getNextRetryTime: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
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
    updateOne: vi.fn(),
  },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: mocks.getServiceOxyClient,
}));

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

  mocks.getKeyPair.mockResolvedValue({
    keyId: 'https://oxy.so/ap/users/instance#main-key',
    publicKeyPem: 'public',
    privateKeyPem: 'private',
  });
  mocks.signRequest.mockReturnValue({
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
  mocks.likeCreate.mockResolvedValue({ _id: 'like_1' });
  mocks.likeFindOneAndDelete.mockReturnValue({
    lean: vi.fn().mockResolvedValue(null),
  });
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.makeServiceRequest.mockResolvedValue({ id: 'oxy_user_1' });
  mocks.getServiceOxyClient.mockReturnValue({
    makeServiceRequest: mocks.makeServiceRequest,
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
    mocks.postExists.mockResolvedValue(null); // no existing boost

    await federationService.processInboxActivity(
      { type: 'Announce', id: announceId, actor: actorUri, object: announcedUri },
      actorUri,
    );

    expect(mocks.postExists).toHaveBeenCalledWith({ 'federation.activityId': announceId });
    expect(mocks.postCreatorCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        oxyUserId: 'oxy_bob',
        boostOf: 'local_post_2',
        federation: expect.objectContaining({ activityId: announceId }),
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
