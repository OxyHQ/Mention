import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Zod validation of the OUTBOX-BACKFILL ActivityPub ingest.
 *
 * The remote actor's outbox (an OrderedCollection / OrderedCollectionPage and
 * its items) arrives from arbitrary, untrusted Fediverse servers. These tests
 * exercise `OutboxSyncService.syncOutboxPostsDetailed` end-to-end (mocked
 * `fetch` + mocked models) to prove:
 *
 *  1. A malformed top-level outbox collection aborts the sync gracefully (empty
 *     result, no crash, no cooldown stamp).
 *  2. A page whose `orderedItems` mix valid + malformed entries imports ONLY the
 *     valid items and skips the malformed ones (one bad post never aborts the
 *     whole backfill).
 *  3. A valid item with a PAST `published` is ingested with `createdAt` equal to
 *     that past instant — the federated-date fix is preserved (no regression).
 *  4. An Announce item is imported as a `type:'boost'` post.
 */

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signRequest: vi.fn(),
  actorFind: vi.fn(),
  actorFindOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  postFind: vi.fn(),
  postFindOne: vi.fn(),
  postFindById: vi.fn(),
  postUpdateOne: vi.fn(),
  postInsertMany: vi.fn(),
  postExists: vi.fn(),
  getServiceOxyClient: vi.fn(),
  makeServiceRequest: vi.fn(),
  persistRemoteMedia: vi.fn(),
  recordAccess: vi.fn(),
  postCreatorCreate: vi.fn(),
}));

vi.mock('../../../utils/federation/crypto', () => ({
  getPublicKey: mocks.getPublicKey,
  signRequest: mocks.signRequest,
}));

vi.mock('../../../models/FederatedActor', () => ({
  default: {
    findOne: mocks.actorFindOne,
    find: mocks.actorFind,
    findOneAndUpdate: mocks.findOneAndUpdate,
    updateOne: mocks.updateOne,
  },
}));

vi.mock('../../../models/Post', () => ({
  // Mirror the real module's `pending` constant so the Stage-A baseline seed
  // resolves it (vitest throws on undefined mock exports).
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

vi.mock('../../../models/UserSettings', () => ({
  default: {
    updateOne: vi.fn(),
  },
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: mocks.getServiceOxyClient,
}));

vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: mocks.persistRemoteMedia,
}));

vi.mock('../../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: mocks.recordAccess,
}));

// The service registry breaks the FederationService <-> PostCreationService
// circular import. Stub the post-creator accessor so federated note/boost
// imports don't pull in the real PostCreationService graph.
vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

import { outboxSyncService } from '../../../services/federation/OutboxSyncService';

const ACTOR_URI = 'https://mastodon.social/users/alice';
const OUTBOX_URL = 'https://mastodon.social/users/alice/outbox';
const FIRST_PAGE_URL = 'https://mastodon.social/users/alice/outbox?page=true';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
    ...init,
  });
}

/** A well-formed `Create` activity wrapping a Note authored by the outbox owner. */
function createNoteActivity(id: string, published: string) {
  return {
    id: `${ACTOR_URI}/statuses/${id}/activity`,
    type: 'Create',
    actor: ACTOR_URI,
    published,
    object: {
      id: `${ACTOR_URI}/statuses/${id}`,
      type: 'Note',
      attributedTo: ACTOR_URI,
      content: `<p>post ${id}</p>`,
      published,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
}

/** Stub the outbox so the collection + a single page resolve from `fetch`. */
function stubOutbox(collection: unknown, page?: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === OUTBOX_URL) return jsonResponse(collection);
    if (url === FIRST_PAGE_URL && page !== undefined) return jsonResponse(page);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const syncOptions = { limit: 10, maxPages: 1 } as const;

function runSync() {
  return outboxSyncService.syncOutboxPostsDetailed(
    { uri: ACTOR_URI, acct: 'alice@mastodon.social', outboxUrl: OUTBOX_URL, oxyUserId: 'oxy_alice' },
    syncOptions,
  );
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/instance#main-key',
    publicKeyPem: 'public',
  });
  mocks.signRequest.mockResolvedValue({
    Host: 'mastodon.social',
    Date: 'Thu, 18 Jun 2026 00:00:00 GMT',
    Signature: 'signature',
  });
  mocks.findOneAndUpdate.mockImplementation(async (_query, update) => ({ _id: 'actor_1', ...update.$set }));
  mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.actorFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  mocks.actorFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.postFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  mocks.postFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.postFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.postInsertMany.mockResolvedValue({ insertedCount: 0 });
  mocks.postExists.mockResolvedValue(null);
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.makeServiceRequest.mockResolvedValue({ id: 'oxy_user_1' });
  mocks.getServiceOxyClient.mockReturnValue({ makeServiceRequest: mocks.makeServiceRequest });
});

describe('OutboxSyncService — collection-level zod validation', () => {
  it('aborts gracefully (no crash, empty result, no cooldown) on a malformed outbox collection', async () => {
    // `orderedItems` is an object instead of an array, and `totalItems` is a
    // string instead of a number — a genuinely malformed OrderedCollection.
    stubOutbox({
      type: 'OrderedCollection',
      totalItems: 'lots',
      orderedItems: { nope: true },
    });

    const result = await runSync();

    expect(result).toMatchObject({
      syncedCount: 0,
      shouldStampCooldown: false,
      reason: 'invalid-collection',
    });
    // Nothing was ingested.
    expect(mocks.postInsertMany).not.toHaveBeenCalled();
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
  });

  it('aborts pagination gracefully when a fetched page is malformed', async () => {
    stubOutbox(
      { type: 'OrderedCollection', totalItems: 1, first: FIRST_PAGE_URL },
      // Malformed page: `orderedItems` is a string, not an array.
      { type: 'OrderedCollectionPage', id: FIRST_PAGE_URL, orderedItems: 'not-an-array' },
    );

    const result = await runSync();

    // Pagination failed → no candidates, no cooldown stamp, no crash.
    expect(result.syncedCount).toBe(0);
    expect(result.shouldStampCooldown).toBe(false);
    expect(mocks.postInsertMany).not.toHaveBeenCalled();
  });
});

describe('OutboxSyncService — per-item zod validation', () => {
  it('imports only the valid items and skips malformed ones in a mixed page', async () => {
    stubOutbox(
      { type: 'OrderedCollection', totalItems: 3, first: FIRST_PAGE_URL },
      {
        type: 'OrderedCollectionPage',
        id: FIRST_PAGE_URL,
        orderedItems: [
          createNoteActivity('1', '2023-04-01T12:00:00Z'),
          // Malformed: a Create whose embedded object is missing the required
          // `id` — fails both `parseInboundActivity` and `parseNote`.
          {
            id: `${ACTOR_URI}/statuses/bad/activity`,
            type: 'Create',
            actor: ACTOR_URI,
            object: { type: 'Note', content: '<p>no id</p>' },
          },
          createNoteActivity('3', '2023-04-03T12:00:00Z'),
        ],
      },
    );

    const result = await runSync();

    // Only the two well-formed notes survived validation.
    expect(result.candidateCount).toBe(2);
    expect(result.newPostCount).toBe(2);
    expect(mocks.postInsertMany).toHaveBeenCalledTimes(1);
    const inserted = mocks.postInsertMany.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(2);
    const activityIds = inserted.map((d) => (d.federation as { activityId?: string }).activityId);
    expect(activityIds).toEqual([
      `${ACTOR_URI}/statuses/1`,
      `${ACTOR_URI}/statuses/3`,
    ]);
    // The malformed item is NOT present.
    expect(activityIds).not.toContain(`${ACTOR_URI}/statuses/bad`);
  });

  it('preserves the original past published date on a valid item (no date regression)', async () => {
    const pastPublished = '2020-01-15T08:30:00.000Z';
    stubOutbox(
      { type: 'OrderedCollection', totalItems: 1, first: FIRST_PAGE_URL },
      {
        type: 'OrderedCollectionPage',
        id: FIRST_PAGE_URL,
        orderedItems: [createNoteActivity('7', pastPublished)],
      },
    );

    const result = await runSync();

    expect(result.newPostCount).toBe(1);
    const inserted = mocks.postInsertMany.mock.calls[0][0] as Array<Record<string, unknown>>;
    const doc = inserted[0];
    // createdAt / updatedAt reflect the ORIGINAL upstream publish instant, not
    // the sync time — proving `parseApPublished` remains the single date authority.
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect((doc.createdAt as Date).toISOString()).toBe(pastPublished);
    expect((doc.updatedAt as Date).toISOString()).toBe(pastPublished);
  });
});

describe('OutboxSyncService — Announce item imports as a boost', () => {
  it('imports a validated Announce as a type:boost post via the boost importer', async () => {
    const announcedUri = 'https://example.org/users/bob/statuses/999';
    const announceId = `${ACTOR_URI}/statuses/announce-1/activity`;
    // The boosted object already exists locally so `resolvePostIdFromObjectUri`
    // returns its id (no remote fetch of the boosted Note needed).
    mocks.postFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: 'local_boosted_post' }) });
    // The boosted post must be public + published for the boost to be imported.
    mocks.postFindById.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ status: 'published', visibility: 'public' }),
    });

    stubOutbox(
      { type: 'OrderedCollection', totalItems: 1, first: FIRST_PAGE_URL },
      {
        type: 'OrderedCollectionPage',
        id: FIRST_PAGE_URL,
        orderedItems: [
          {
            id: announceId,
            type: 'Announce',
            actor: ACTOR_URI,
            object: announcedUri,
            published: '2024-05-20T10:00:00Z',
          },
        ],
      },
    );

    const result = await runSync();

    expect(result.importedBoostCount).toBe(1);
    expect(mocks.postCreatorCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        oxyUserId: 'oxy_alice',
        boostOf: 'local_boosted_post',
        // A boost mirrors native reposts: empty content body, hydrated via boostOf.
        content: { text: '' },
        federation: expect.objectContaining({ activityId: announceId }),
        // The boost Post's date reflects when the Announce happened.
        createdAt: new Date('2024-05-20T10:00:00Z'),
        updatedAt: new Date('2024-05-20T10:00:00Z'),
      }),
    );
    // The boosted post's counter moved +1 in lockstep with the new boost record.
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: 'local_boosted_post' },
      { $inc: { 'stats.boostsCount': 1 } },
    );
  });
});

describe('OutboxSyncService — outbox URL SSRF hardening', () => {
  it('does not fetch cross-origin string items or Create.object URLs from an outbox page', async () => {
    const fetchMock = stubOutbox({
      type: 'OrderedCollection',
      totalItems: 2,
      orderedItems: [
        'http://169.254.169.254/latest/meta-data/',
        {
          id: `${ACTOR_URI}/activities/create-evil`,
          type: 'Create',
          actor: ACTOR_URI,
          object: 'http://127.0.0.1/private-note',
        },
      ],
    });

    const result = await runSync();

    expect(result).toMatchObject({
      syncedCount: 0,
      reason: 'no-candidates',
      candidateCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      OUTBOX_URL,
      expect.objectContaining({ headers: expect.objectContaining({ Accept: expect.stringContaining('application/activity+json') }) }),
    );
  });

  it('caps inspected non-candidate items and returns an item-offset cursor', async () => {
    const orderedItems = Array.from({ length: 105 }, (_, index) => `http://169.254.169.254/latest/meta-data/${index}`);
    const fetchMock = stubOutbox({
      type: 'OrderedCollection',
      totalItems: orderedItems.length,
      orderedItems,
    });

    const result = await outboxSyncService.syncOutboxPostsDetailed(
      { uri: ACTOR_URI, acct: 'alice@mastodon.social', outboxUrl: OUTBOX_URL, oxyUserId: 'oxy_alice' },
      { limit: 10, maxPages: 1 },
    );

    expect(result).toMatchObject({
      syncedCount: 0,
      reason: 'no-candidates',
      candidateCount: 0,
      nextCursor: { url: OUTBOX_URL, itemOffset: 100 },
      reachedEnd: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
