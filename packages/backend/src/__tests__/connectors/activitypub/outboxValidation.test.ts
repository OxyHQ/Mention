import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { asc, like } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { findPostRecords, loadPostRecord } from '../../../db/posts/postRepository';
import type { PostRecord } from '../../../db/posts/postRecord';
import {
  clearFederationScope,
  federationScope,
  seedPost,
} from '../../helpers/federationFixtures';

const scope = federationScope('outbox-validation');

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  // Production inserted these, so `seedPost`'s id tracking never saw them.
  await getDb().delete(posts).where(like(posts.federationActivityId, `${ACTOR_URI}/%`));
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

/**
 * Zod validation of the OUTBOX-BACKFILL ActivityPub ingest.
 *
 * The remote actor's outbox (an OrderedCollection / OrderedCollectionPage and
 * its items) arrives from arbitrary, untrusted Fediverse servers. These tests
 * exercise `OutboxSyncService.syncOutboxPostsDetailed` end-to-end (mocked
 * `fetch`, REAL `posts` rows) to prove:
 *
 *  1. A malformed top-level outbox collection aborts the sync gracefully (empty
 *     result, no crash, no cooldown stamp).
 *  2. A page whose `orderedItems` mix valid + malformed entries imports ONLY the
 *     valid items and skips the malformed ones (one bad post never aborts the
 *     whole backfill).
 *  3. A valid item with a PAST `published` is ingested with `createdAt` equal to
 *     that past instant — the federated-date fix is preserved (no regression).
 *  4. An Announce item is imported as a `type:'boost'` post.
 *
 * ## The insert is read back, not spied on
 *
 * Batch 7 replaced the raw `Post.collection.insertMany` with per-row
 * `insertPostRecord` calls against Postgres, so the `insertMany` spy this suite
 * asserted on stopped being called at all — and with it went the only evidence
 * that a validated item was ever ingested. The four abort/reject cases kept
 * passing on `not.toHaveBeenCalled()`, which a spy nothing calls satisfies for
 * the wrong reason.
 *
 * Assertions now read the rows back. That is strictly stronger than the spy was:
 * the spy saw the document the service BUILT, while a row proves it survived the
 * schema's own CHECK constraints — and the "one bad item must not abort the
 * batch" property is about what actually landed, which a single spied call
 * argument could never show.
 */

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  getServiceOxyClient: vi.fn(),
  makeServiceRequest: vi.fn(),
  persistRemoteMedia: vi.fn(),
  recordAccess: vi.fn(),
  postCreatorCreate: vi.fn(),
  fetchUpstreamSingleHop: vi.fn(),
  assertSafePublicUrl: vi.fn(),
}));

// `signedFetch` (helpers.ts) is built from @oxyhq/federation's createSignedFetch,
// which signs via Mention's injected `signViaOxy` (crypto.ts) and derives the
// instance keyId from `getPublicKey('instance')`. The package's real signRequest
// composes the Signature header; only the private-key custody is stubbed here.
vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: mocks.getPublicKey,
  signViaOxy: mocks.signViaOxy,
}));

// `signedFetch` performs its GET via the IP-pinned `fetchUpstreamSingleHop`
// (no global `fetch`). Route it through the per-test stubbed global `fetch` so
// these outbox fixtures keep exercising the real validation/ingest logic; only
// the transport is adapted.
vi.mock('../../../utils/safeUpstreamFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/safeUpstreamFetch')>();
  return {
    ...actual,
    fetchUpstreamSingleHop: mocks.fetchUpstreamSingleHop,
  };
});

vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  assertSafePublicUrl: mocks.assertSafePublicUrl,
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

import { outboxSyncService } from '../../../connectors/activitypub/outbox.service';

const ACTOR_URI = `${scope.origin}/users/alice`;
const OUTBOX_URL = `${ACTOR_URI}/outbox`;
const FIRST_PAGE_URL = `${ACTOR_URI}/outbox?page=true`;
const OWNER_OXY_ID = 'oxy_alice';

/**
 * The posts this suite's SUBJECT wrote, oldest-first.
 *
 * Scoped by `federation.activity_id` prefix rather than by author: the ids are
 * built from `scope.origin`, so this can only ever see rows this file's sync
 * created — which is also what makes the teardown below safe under vitest's
 * parallel file execution.
 */
function importedPosts(): Promise<PostRecord[]> {
  return findPostRecords(
    like(posts.federationActivityId, `${ACTOR_URI}/%`),
    { orderBy: [asc(posts.createdAt)] },
  );
}

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
  mocks.signViaOxy.mockResolvedValue('c2lnbmF0dXJl'); // base64 stub signature
  mocks.findOneAndUpdate.mockImplementation(async (_query, update) => ({ _id: 'actor_1', ...update.$set }));
  mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.makeServiceRequest.mockResolvedValue({ id: 'oxy_user_1' });
  mocks.getServiceOxyClient.mockReturnValue({ makeServiceRequest: mocks.makeServiceRequest });
  mocks.assertSafePublicUrl.mockResolvedValue({ ok: true, ip: '93.184.216.34', family: 4 });
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
    expect(await importedPosts()).toHaveLength(0);
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
    expect(await importedPosts()).toHaveLength(0);
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
    // Both good rows LANDED. Reading them back is what makes "one bad item does
    // not abort the batch" a statement about the database rather than about the
    // single array the service happened to hand its writer.
    const inserted = await importedPosts();
    expect(inserted.map((post) => post.federation?.activityId)).toEqual([
      `${ACTOR_URI}/statuses/1`,
      `${ACTOR_URI}/statuses/3`,
    ]);
  });


  it('rejects Create items whose actor or attributedTo does not match the synced outbox owner', async () => {
    const victimUri = 'https://victim.example/users/bob';
    stubOutbox(
      { type: 'OrderedCollection', totalItems: 2, first: FIRST_PAGE_URL },
      {
        type: 'OrderedCollectionPage',
        id: FIRST_PAGE_URL,
        orderedItems: [
          {
            ...createNoteActivity('forged-actor', '2023-04-04T12:00:00Z'),
            actor: victimUri,
          },
          {
            id: `${ACTOR_URI}/statuses/forged-attributed/activity`,
            type: 'Create',
            actor: ACTOR_URI,
            published: '2023-04-05T12:00:00Z',
            object: {
              id: `${ACTOR_URI}/statuses/forged-attributed`,
              type: 'Note',
              attributedTo: victimUri,
              content: '<p>forged</p>',
              published: '2023-04-05T12:00:00Z',
              to: ['https://www.w3.org/ns/activitystreams#Public'],
            },
          },
        ],
      },
    );

    const result = await runSync();

    expect(result).toMatchObject({ syncedCount: 0, candidateCount: 0, reason: 'no-candidates' });
    expect(await importedPosts()).toHaveLength(0);
  });

  it('rejects outbox notes whose activity id belongs to another actor and stores verified actorUri on accepted notes', async () => {
    stubOutbox(
      { type: 'OrderedCollection', totalItems: 2, first: FIRST_PAGE_URL },
      {
        type: 'OrderedCollectionPage',
        id: FIRST_PAGE_URL,
        orderedItems: [
          {
            id: 'https://victim.example/users/bob/statuses/forged-id/activity',
            type: 'Create',
            actor: ACTOR_URI,
            published: '2023-04-04T12:00:00Z',
            object: {
              id: 'https://victim.example/users/bob/statuses/forged-id',
              type: 'Note',
              attributedTo: ACTOR_URI,
              content: '<p>forged id</p>',
              published: '2023-04-04T12:00:00Z',
              to: ['https://www.w3.org/ns/activitystreams#Public'],
            },
          },
          createNoteActivity('accepted', '2023-04-05T12:00:00Z'),
        ],
      },
    );

    const result = await runSync();

    expect(result.candidateCount).toBe(1);
    expect(result.newPostCount).toBe(1);
    const inserted = await importedPosts();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].oxyUserId).toBe(OWNER_OXY_ID);
    expect(inserted[0].federation).toEqual(
      expect.objectContaining({
        activityId: `${ACTOR_URI}/statuses/accepted`,
        actorUri: ACTOR_URI,
      }),
    );
    // The forged id is not merely absent from one insert call — no row carries
    // it, which is the only form of "rejected" a later reader can rely on.
    const forged = await findPostRecords(
      like(posts.federationActivityId, 'https://victim.example/%'),
      { orderBy: [asc(posts.createdAt)] },
    );
    expect(forged).toHaveLength(0);
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
    const [doc] = await importedPosts();
    // createdAt / updatedAt reflect the ORIGINAL upstream publish instant, not
    // the sync time — proving `parseApPublished` remains the single date
    // authority. Read from the STORED row, so a column default that overwrote
    // the supplied instant would fail here; the spy could not have seen that.
    expect(doc.createdAt.toISOString()).toBe(pastPublished);
    expect(doc.updatedAt.toISOString()).toBe(pastPublished);
  });
});

describe('OutboxSyncService — Announce item imports as a boost', () => {
  it('imports a validated Announce as a type:boost post via the boost importer', async () => {
    const announcedUri = `${scope.origin}/users/bob/statuses/999`;
    const announceId = `${ACTOR_URI}/statuses/announce-1/activity`;
    // The boosted object is a REAL row, so `resolvePostIdFromObjectUri` finds it
    // by `federation.activity_id` and no remote fetch of the Note is needed. Its
    // published+public state is what lets the boost import at all, and it is now
    // the row's state rather than a stubbed answer.
    const boosted = await seedPost(scope, {
      federation: { activityId: announcedUri, actorUri: `${scope.origin}/users/bob` },
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
        oxyUserId: OWNER_OXY_ID,
        boostOf: boosted.id,
        // A boost mirrors native reposts: empty content body, hydrated via boostOf.
        content: { text: '' },
        federation: expect.objectContaining({ activityId: announceId }),
        // The boost Post's date reflects when the Announce happened.
        createdAt: new Date('2024-05-20T10:00:00Z'),
        updatedAt: new Date('2024-05-20T10:00:00Z'),
      }),
    );
    // The boosted post's counters moved +1 in lockstep with the new boost record:
    // both the native boost total and the federated-boost subset. Read from the
    // row, so the increment is the stored value and not the shape of an update
    // document — `boostsCount - federatedBoostsCount` is what isolates native
    // boosts, and only the stored pair can show it holding.
    const after = await loadPostRecord(boosted.id);
    expect(after?.stats.boostsCount).toBe(boosted.stats.boostsCount + 1);
    expect(after?.stats.federatedBoostsCount).toBe(boosted.stats.federatedBoostsCount + 1);
  });

  it('rejects an Announce whose activity id belongs to another actor', async () => {
    // The Announce branch has its OWN `activityIdBelongsToActor` guard, and it
    // had no test: deleting it left this file green, while deleting the Note
    // branch's copy turned a case red. An id under someone else's host is how a
    // hostile outbox claims a boost it never made — and the boost record would
    // carry OUR synced actor as its author, since `oxyUserId` comes from the
    // outbox owner, not from the id.
    const boosted = await seedPost(scope, {
      federation: { activityId: `${scope.origin}/users/bob/statuses/888`, actorUri: `${scope.origin}/users/bob` },
    });

    stubOutbox(
      { type: 'OrderedCollection', totalItems: 1, first: FIRST_PAGE_URL },
      {
        type: 'OrderedCollectionPage',
        id: FIRST_PAGE_URL,
        orderedItems: [
          {
            id: 'https://victim.example/users/bob/statuses/announce-forged/activity',
            type: 'Announce',
            actor: ACTOR_URI,
            object: `${scope.origin}/users/bob/statuses/888`,
            published: '2024-05-21T10:00:00Z',
          },
        ],
      },
    );

    const result = await runSync();

    expect(result.importedBoostCount).toBe(0);
    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    // The boosted post's counters never moved either — a rejected Announce must
    // leave no trace at all, not merely skip the post insert.
    const after = await loadPostRecord(boosted.id);
    expect(after?.stats.boostsCount).toBe(boosted.stats.boostsCount);
    expect(after?.stats.federatedBoostsCount).toBe(boosted.stats.federatedBoostsCount);
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
