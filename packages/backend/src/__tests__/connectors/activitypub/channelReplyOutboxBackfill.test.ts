import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Site 4 of four for `utils/channelReplyGate`: the ActivityPub OUTBOX BACKFILL.
 *
 * This is the route that does not go through `PostCreationService` at all — it
 * assembles records and writes them directly through the repository, bypassing
 * every guard that lives in the creation service. A candidate that is not
 * filtered out BEFORE that insert is stored unchallenged, so the refusal has to
 * happen inside the candidate loop.
 *
 * The parents are REAL ROWS and the assertions are on STORED posts. The gate
 * reads the parent's AUTHOR (`posts.oxy_user_id`) with a `text` id, and the guard
 * it replaced (`ObjectId.isValid`) answered `false` for every uuid v7 — which
 * reads as "not a channel post" and lets the reply through. A mocked `findById`
 * answers whatever it was told, so it cannot see that; and "insertMany was called
 * with these docs" cannot see whether the row survived the write either. Only the
 * KIND lookup is mocked (`isChannelAccount`), because that answer lives in Oxy.
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

vi.mock('../../../db/userProfile/userSettingsRepository', () => ({
  updateUserSettings: vi.fn(),
}));

vi.mock('../../../db/federation/followRepository', () => ({
  existsFollow: vi.fn().mockResolvedValue(true),
  findFollows: vi.fn().mockResolvedValue([]),
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

// The gate resolves the parent AUTHOR's account kind here — the one module that
// knows what a channel account is. Mocked so this file needs no Oxy identity
// path, and so a test that expects a SKIP has to seed the parent under a channel
// account itself. The factory only CLOSES OVER `CHANNEL_ACCOUNT` below; the
// closure does not run until the gate resolves an author, long after this module
// finished initializing, so the `vi.mock` hoisting is harmless.
vi.mock('../../../services/publishAsAccount', () => ({
  isChannelAccount: (oxyUserId: string) => Promise.resolve(oxyUserId === CHANNEL_ACCOUNT),
}));

import { like } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import {
  clearFederationScope,
  federationScope,
  seedPost,
} from '../../helpers/federationFixtures';
import * as channelReplyGate from '../../../utils/channelReplyGate';
import { outboxSyncService } from '../../../connectors/activitypub/outbox.service';

const scope = federationScope('channel-reply-outbox');
/**
 * The actor host is the SUITE's own, not the shared `mastodon.social`.
 *
 * Teardown here deletes by `federation.activity_id LIKE '<actor>%'`, and `posts`
 * carries no column naming the suite that wrote a row — so a shared actor URI
 * makes that predicate a claim about every other file in the run. It reached
 * `postCreationEnrichment`'s rows and deleted them mid-assertion, which is the
 * exact hazard `federationFixtures` namespaces everything else against.
 */
const ACTOR_URI = `${scope.origin}/users/alice`;
const OUTBOX_URL = `${ACTOR_URI}/outbox`;
const ALICE_OXY_ID = scope.user('alice');
/** The Oxy account the mocked `isChannelAccount` answers `true` for. */
const CHANNEL_ACCOUNT = scope.user('channel');

const REMOTE_POST_URI = `${scope.origin}/users/bob/statuses/42`;

/** The default `FEDERATION_DOMAIN` (`config/index.ts`), so this IS a local URI. */
function localUri(postId: string): string {
  return `https://mention.earth/ap/users/nate/posts/${postId}`;
}

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
    { uri: ACTOR_URI, acct: `alice@${scope.domain}`, outboxUrl: OUTBOX_URL, oxyUserId: ALICE_OXY_ID },
    { limit: 10, maxPages: 1 },
  );
}

/** The `federation.activity_id` of every post this run actually STORED. */
async function insertedActivityIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ activityId: posts.federationActivityId })
    .from(posts)
    .where(like(posts.federationActivityId, `${ACTOR_URI}%`));
  return rows.map((row) => row.activityId ?? '').sort();
}

/**
 * The ids the channel gate looked up — empty when it never queried.
 *
 * A pass-through spy on the real function, so the gate still RUNS and its answer
 * still decides the outcome. Counting a mock that replaced it would make the two
 * assertions in each case independent of one another.
 */
let gateSpy: ReturnType<typeof vi.spyOn>;
function gateLookups(): string[] {
  return gateSpy.mock.calls.map(([id]) => String(id));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  await getDb().delete(posts).where(like(posts.federationActivityId, `${ACTOR_URI}%`));
  await clearFederationScope(scope);
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  gateSpy = vi.spyOn(channelReplyGate, 'parentIsChannelPost');

  mocks.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/instance#main-key',
    publicKeyPem: 'public',
  });
  mocks.signViaOxy.mockResolvedValue('c2lnbmF0dXJl');
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

describe('outbox backfill — a reply to a channel post is never stored', () => {
  it('skips the channel reply and still imports the rest of the page', async () => {
    const channelPost = await seedPost(scope, { oxyUserId: CHANNEL_ACCOUNT });
    stubOutbox([
      createNote('to-channel', localUri(channelPost.id)),
      createNote('ordinary'),
    ]);

    const result = await runOutboxSync();

    expect(gateLookups()).toContain(channelPost.id);
    // A REFUSAL, not an aborted batch: the page's other note still landed.
    expect(await insertedActivityIds()).toEqual([`${ACTOR_URI}/statuses/ordinary`]);
    expect(result.newPostCount).toBe(1);
  });

  it('CONTROL: a reply to an ordinary LOCAL post is imported', async () => {
    const plainPost = await seedPost(scope);
    stubOutbox([createNote('to-local', localUri(plainPost.id))]);

    await runOutboxSync();

    // Same path, same lookup, opposite outcome — which is what makes the case
    // above about the channel rather than about local replies being dropped.
    expect(gateLookups()).toContain(plainPost.id);
    expect(await insertedActivityIds()).toEqual([`${ACTOR_URI}/statuses/to-local`]);
  });

  it('CONTROL: a reply to a REMOTE post is imported without any gate lookup', async () => {
    // A remote object is authored by a remote actor, which is never a local
    // channel account, so the URI parse short-circuits before the query. This is
    // what keeps the gate free on the ordinary remote-to-remote reply.
    stubOutbox([createNote('to-remote', REMOTE_POST_URI)]);

    await runOutboxSync();

    expect(gateLookups()).toEqual([]);
    expect(await insertedActivityIds()).toEqual([`${ACTOR_URI}/statuses/to-remote`]);
  });
});
