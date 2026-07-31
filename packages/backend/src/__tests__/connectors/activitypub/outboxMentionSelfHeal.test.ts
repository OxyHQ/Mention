import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Organic SELF-HEAL of federated @mentions during outbox re-sync.
 *
 * The outbox mention fix resolves @mentions for NEW federated Note imports, but a
 * post imported BEFORE that fix keeps its mentions as bare `@name` text — and the
 * dedup pass (by `federation.activityId`) skips it on every re-sync, so it never
 * heals. The self-heal closes that gap WITHOUT any extra fetch: the re-sync has
 * already fetched the outbox page, so the original Note (with its `Mention` tags)
 * is in hand; the matching EXISTING post is re-resolved from that in-hand note and
 * its `[mention:<id>]` placeholders + `mentions` allowlist are written back.
 *
 * These pin:
 *   - an existing post whose stored mentions never resolved gets its body variants
 *     rewritten to `[mention:<id>]` placeholders and its `mentions` allowlist set,
 *     with NO extra network fetch (only the single outbox GET);
 *   - an ALREADY-resolved post is never touched (no resolution, no write);
 *   - a resolve MISS (mentioned actor unresolvable) leaves the post as-is.
 *
 * The mock harness mirrors `outboxValidation.test.ts` (mocked `fetch` + models) and
 * additionally stubs `actor.service` so the mentioned actor resolves from the
 * (mocked) actor cache — proving the heal issues no network fetch of its own.
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

// `signedFetch` performs its GET via the IP-pinned `fetchUpstreamSingleHop` (no
// global `fetch`). Route it through the per-test stubbed global `fetch` so the
// real validation/ingest logic runs; only the transport is adapted.
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

// Stub `actor.service` so the mentioned actor resolves from the actor cache — no
// network fetch. The outbox owner is seeded from `actor.oxyUserId`, so
// `fetchRemoteActor` is never reached here (provided only for completeness).
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

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

import { outboxSyncService } from '../../../connectors/activitypub/outbox.service';

const ACTOR_URI = 'https://mastodon.social/users/alice';
const OUTBOX_URL = 'https://mastodon.social/users/alice/outbox';

const BOB_URI = 'https://mastodon.example/users/bob';
const BOB_PROFILE = 'https://mastodon.example/@bob';
const BOB_OXY_ID = 'oxy_bob';

/** The activity id (= note id) of the note that mentions @bob. */
const MENTION_NOTE_ID = `${ACTOR_URI}/statuses/withmention`;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
    ...init,
  });
}

/**
 * A Mastodon-style `Create(Note)` authored by the outbox owner that mentions
 * @bob: the `Mention` tag href is bob's actor URI, and the in-content anchor
 * points at bob's profile page (the exact shape the resolver matches by href).
 */
function createNoteMentioningBob() {
  return {
    id: `${MENTION_NOTE_ID}/activity`,
    type: 'Create',
    actor: ACTOR_URI,
    published: '2023-04-01T12:00:00Z',
    object: {
      id: MENTION_NOTE_ID,
      type: 'Note',
      attributedTo: ACTOR_URI,
      content: `<p>hi <a href="${BOB_PROFILE}" class="u-url mention">@bob</a></p>`,
      tag: [{ type: 'Mention', href: BOB_URI, name: '@bob@mastodon.example' }],
      published: '2023-04-01T12:00:00Z',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
}

/** Stub the outbox so the whole collection (with inline items) resolves from ONE GET. */
function stubOutbox(collection: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === OUTBOX_URL) return jsonResponse(collection);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Make the dedup query report an existing post for the mention note. */
function stubExistingPost(mentions: string[]): void {
  mocks.postFind.mockReturnValue({
    lean: vi.fn().mockResolvedValue([
      { federation: { activityId: MENTION_NOTE_ID }, mentions, content: {} },
    ]),
  });
}

function runSync() {
  return outboxSyncService.syncOutboxPostsDetailed(
    { uri: ACTOR_URI, acct: 'alice@mastodon.social', outboxUrl: OUTBOX_URL, oxyUserId: 'oxy_alice' },
    { limit: 10, maxPages: 1 },
  );
}

beforeEach(() => {
  vi.clearAllMocks();

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
  mocks.postFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.postInsertMany.mockResolvedValue({ insertedCount: 0 });
  mocks.postExists.mockResolvedValue(null);
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
  // Default: @bob resolves from the actor cache (no network fetch).
  mocks.getOrFetchActor.mockImplementation(async (uri: string) =>
    uri === BOB_URI ? { oxyUserId: BOB_OXY_ID } : null,
  );
});

describe('OutboxSyncService — @mention self-heal on re-sync', () => {
  it('heals an existing post with bare-text mentions from the in-hand note, with NO extra fetch', async () => {
    // The post already exists (deduped) but its stored mention allowlist is empty
    // — a pre-fix import that never resolved @bob.
    stubExistingPost([]);
    const fetchMock = stubOutbox({
      type: 'OrderedCollection',
      totalItems: 1,
      orderedItems: [createNoteMentioningBob()],
    });

    const result = await runSync();

    // One existing post healed; nothing new inserted.
    expect(result.healedMentionCount).toBe(1);
    expect(result.newPostCount).toBe(0);
    expect(mocks.postInsertMany).not.toHaveBeenCalled();

    // The heal write rewrites the body variant to the `[mention:<id>]` placeholder
    // and sets the `mentions` allowlist — in lockstep, like the inbox Update path.
    const healCall = mocks.postUpdateOne.mock.calls.find(
      ([filter]) =>
        (filter as { 'federation.activityId'?: string })['federation.activityId'] === MENTION_NOTE_ID,
    );
    if (!healCall) throw new Error('expected a heal updateOne for the mention note');
    const update = healCall[1] as {
      $set: { mentions: string[]; 'content.variants': Array<{ text: string }> };
    };
    expect(update.$set.mentions).toEqual([BOB_OXY_ID]);
    expect(update.$set['content.variants']).toHaveLength(1);
    expect(update.$set['content.variants'][0].text).toContain(`[mention:${BOB_OXY_ID}]`);
    expect(update.$set['content.variants'][0].text).not.toContain('<a');

    // No extra network fetch: only the single outbox GET ran. The note was already
    // in hand and @bob resolved from the (mocked) actor cache, not the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(OUTBOX_URL, expect.anything());
  });

  it('leaves an ALREADY-resolved post untouched (no resolution, no write)', async () => {
    // Stored allowlist already covers the note's single mention → not a candidate.
    stubExistingPost([BOB_OXY_ID]);
    stubOutbox({
      type: 'OrderedCollection',
      totalItems: 1,
      orderedItems: [createNoteMentioningBob()],
    });

    const result = await runSync();

    expect(result.healedMentionCount).toBe(0);
    // Never re-resolves and never rewrites an already-resolved post.
    expect(mocks.getOrFetchActor).not.toHaveBeenCalled();
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });

  it('leaves the post as-is on a resolve MISS (mentioned actor unresolvable)', async () => {
    stubExistingPost([]);
    stubOutbox({
      type: 'OrderedCollection',
      totalItems: 1,
      orderedItems: [createNoteMentioningBob()],
    });
    // @bob cannot be resolved this run.
    mocks.getOrFetchActor.mockResolvedValue(null);

    const result = await runSync();

    expect(result.healedMentionCount).toBe(0);
    // The heal was attempted (bounded resolution ran) but wrote nothing.
    expect(mocks.getOrFetchActor).toHaveBeenCalledWith(BOB_URI);
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });
});
