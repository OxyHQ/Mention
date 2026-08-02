import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Site 4 of four for `utils/channelReplyGate`: the ActivityPub OUTBOX BACKFILL.
 *
 * This is the route that does not go through `PostCreationService` at all — it
 * assembles raw documents and writes them with `Post.collection.insertMany`,
 * bypassing Mongoose middleware, schema defaults and every write guard. A
 * candidate that is not filtered out BEFORE that insert is stored unchallenged,
 * so the refusal has to happen inside the candidate loop.
 *
 * Driven through the real entry point (`syncOutboxPostsDetailed`) against the
 * harness `federatedPostEnrichment.test.ts` established, so what is asserted is
 * the call site the route actually reaches rather than a helper in isolation.
 *
 * THREE things are pinned, and the second and third are what stop this from being
 * a check that cannot fail:
 *  - a reply naming a LOCAL channel post is skipped, and the page's other notes
 *    still import (a refusal, not an aborted batch);
 *  - a reply naming a LOCAL ordinary post is imported;
 *  - a reply naming a REMOTE post never triggers the lookup at all — the parse is
 *    what keeps the gate free on the ordinary remote-to-remote reply that makes
 *    up nearly every backfilled thread.
 */

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
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
  getLinkPreviews: vi.fn(),
  getLinkPreview: vi.fn(),
  persistRemoteMedia: vi.fn(),
  recordAccess: vi.fn(),
  postCreatorCreate: vi.fn(),
  fetchUpstreamSingleHop: vi.fn(),
  assertSafePublicUrl: vi.fn(),
  getOrFetchActor: vi.fn(),
  fetchRemoteActor: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: mocks.getPublicKey,
  signViaOxy: mocks.signViaOxy,
}));

vi.mock('../../../utils/safeUpstreamFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/safeUpstreamFetch')>();
  return { ...actual, fetchUpstreamSingleHop: mocks.fetchUpstreamSingleHop };
});

vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  assertSafePublicUrl: mocks.assertSafePublicUrl,
}));

vi.mock('../../../connectors/activitypub/actor.service', () => ({
  actorService: {
    getOrFetchActor: mocks.getOrFetchActor,
    fetchRemoteActor: mocks.fetchRemoteActor,
  },
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
  POST_CLASSIFICATION_PENDING: 'pending',
  Post: {
    find: mocks.postFind,
    findOne: mocks.postFindOne,
    findById: mocks.postFindById,
    updateOne: mocks.postUpdateOne,
    exists: mocks.postExists,
    collection: { insertMany: mocks.postInsertMany },
  },
}));

vi.mock('../../../models/UserSettings', () => ({ default: { updateOne: vi.fn() } }));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: mocks.getServiceOxyClient,
}));

vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: mocks.persistRemoteMedia,
}));

vi.mock('../../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: mocks.recordAccess,
}));

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

vi.mock('../../../models/FederatedFollow', () => ({
  default: { exists: vi.fn().mockResolvedValue({ _id: 'follow_1' }) },
}));

// The gate resolves the parent AUTHOR's account kind here — the one module that
// knows what a channel account is. Mocked so this file needs no Oxy identity
// path, and so a test that expects a SKIP has to say the author is a channel.
vi.mock('../../../services/publishAsAccount', () => ({
  isChannelAccount: (oxyUserId: string) => Promise.resolve(oxyUserId === CHANNEL_ACCOUNT),
}));

import { outboxSyncService } from '../../../connectors/activitypub/outbox.service';

/** Hoisted above the `vi.mock` factory that reads it — `vi.mock` calls are hoisted too. */
const CHANNEL_ACCOUNT = 'oxy-channel-account';

const ACTOR_URI = 'https://mastodon.social/users/alice';
const OUTBOX_URL = 'https://mastodon.social/users/alice/outbox';
const ALICE_OXY_ID = 'oxy_alice';

/** The default `FEDERATION_DOMAIN` (`config/index.ts`), so these ARE local URIs. */
const LOCAL_CHANNEL_POST_ID = '507f1f77bcf86cd799439011';
const LOCAL_PLAIN_POST_ID = '507f1f77bcf86cd799439012';
const LOCAL_CHANNEL_POST_URI = `https://mention.earth/ap/users/nate/posts/${LOCAL_CHANNEL_POST_ID}`;
const LOCAL_PLAIN_POST_URI = `https://mention.earth/ap/users/nate/posts/${LOCAL_PLAIN_POST_ID}`;
const REMOTE_POST_URI = 'https://mastodon.social/users/bob/statuses/42';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
  });
}

function createNote(id: string, inReplyTo?: string) {
  const noteId = `${ACTOR_URI}/statuses/${id}`;
  return {
    id: `${noteId}/activity`,
    type: 'Create',
    actor: ACTOR_URI,
    published: '2023-04-01T12:00:00Z',
    object: {
      id: noteId,
      type: 'Note',
      attributedTo: ACTOR_URI,
      content: `<p>note ${id}</p>`,
      published: '2023-04-01T12:00:00Z',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      ...(inReplyTo ? { inReplyTo } : {}),
    },
  };
}

function stubOutbox(orderedItems: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === OUTBOX_URL) {
        return jsonResponse({ type: 'OrderedCollection', totalItems: orderedItems.length, orderedItems });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

function runOutboxSync() {
  return outboxSyncService.syncOutboxPostsDetailed(
    { uri: ACTOR_URI, acct: 'alice@mastodon.social', outboxUrl: OUTBOX_URL, oxyUserId: ALICE_OXY_ID },
    { limit: 10, maxPages: 1 },
  );
}

/** The `federation.activityId` of every doc the raw insert was handed. */
function insertedActivityIds(): string[] {
  return mocks.postInsertMany.mock.calls.flatMap(([docs]) =>
    (docs as Array<{ federation?: { activityId?: string } }>).map(
      (doc) => doc.federation?.activityId ?? '',
    ),
  );
}

/** The ids the channel gate looked up — empty when it never queried. */
function gateLookups(): string[] {
  return mocks.postFindById.mock.calls.map(([id]) => String(id));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();

  mocks.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/instance#main-key',
    publicKeyPem: 'public',
  });
  mocks.signViaOxy.mockResolvedValue('c2lnbmF0dXJl');
  mocks.findOneAndUpdate.mockImplementation(async (_query, update) => ({ _id: 'actor_1', ...update.$set }));
  mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.actorFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  mocks.actorFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.postFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  mocks.postFindOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  // The gate's own projection. Default: an ordinary post — so a test that expects
  // a SKIP has to set the channel itself, and cannot pass by accident.
  mocks.postFindById.mockImplementation((id: string) => ({
    select: () => ({
      lean: async () =>
        id === LOCAL_CHANNEL_POST_ID
          ? { oxyUserId: CHANNEL_ACCOUNT }
          : { oxyUserId: 'oxy-person' },
    }),
    lean: vi.fn().mockResolvedValue(null),
  }));
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.postInsertMany.mockResolvedValue({ insertedCount: 1 });
  mocks.postExists.mockResolvedValue(null);
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.makeServiceRequest.mockResolvedValue({ id: 'oxy_user_1' });
  mocks.getLinkPreviews.mockResolvedValue({});
  mocks.getLinkPreview.mockResolvedValue(undefined);
  mocks.getServiceOxyClient.mockReturnValue({
    makeServiceRequest: mocks.makeServiceRequest,
    getLinkPreviews: mocks.getLinkPreviews,
    getLinkPreview: mocks.getLinkPreview,
  });
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
  mocks.getOrFetchActor.mockResolvedValue({ uri: ACTOR_URI, oxyUserId: ALICE_OXY_ID, type: 'Person' });
});

describe('outbox backfill — a reply to a channel post never reaches insertMany', () => {
  it('skips the channel reply and still imports the rest of the page', async () => {
    stubOutbox([
      createNote('to-channel', LOCAL_CHANNEL_POST_URI),
      createNote('ordinary'),
    ]);

    const result = await runOutboxSync();

    expect(gateLookups()).toContain(LOCAL_CHANNEL_POST_ID);
    expect(insertedActivityIds()).toEqual([`${ACTOR_URI}/statuses/ordinary`]);
    expect(result.newPostCount).toBe(1);
  });

  it('CONTROL: a reply to an ordinary LOCAL post is imported', async () => {
    stubOutbox([createNote('to-local', LOCAL_PLAIN_POST_URI)]);

    await runOutboxSync();

    expect(gateLookups()).toContain(LOCAL_PLAIN_POST_ID);
    expect(insertedActivityIds()).toEqual([`${ACTOR_URI}/statuses/to-local`]);
  });

  it('CONTROL: a reply to a REMOTE post is imported without any gate lookup', async () => {
    // A remote object is authored by a remote actor, which is never a local
    // channel account, so the URI parse short-circuits before the query. This is
    // what keeps the gate free on the ordinary remote-to-remote reply.
    stubOutbox([createNote('to-remote', REMOTE_POST_URI)]);

    await runOutboxSync();

    expect(gateLookups()).toEqual([]);
    expect(insertedActivityIds()).toEqual([`${ACTOR_URI}/statuses/to-remote`]);
  });
});
