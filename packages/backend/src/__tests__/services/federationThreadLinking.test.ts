import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { and, eq, like, ne } from 'drizzle-orm';

/**
 * Thread-linking for federated reply import.
 *
 * Root cause being verified: federated replies stored `federation.inReplyTo`
 * (the raw remote parent URI) but never set the local `parentPostId` /
 * `threadId` the thread machinery reads — so replies imported as orphans, the
 * outbox path DROPPED replies entirely, and ancestors were never fetched.
 *
 * ## What changed with the Postgres port
 *
 * The old suite backed `models/Post` with a hand-written in-memory store: about
 * 150 lines re-implementing `findOne`, `find`, `updateOne`, `bulkWrite`,
 * `insertMany` and `countDocuments` well enough to interpret the specific
 * queries this code path builds. The thing it could not do is fail the way the
 * real database fails — it answered whatever the re-implementation decided a
 * filter meant, so a query that matched nothing in Postgres and a query that
 * matched correctly were indistinguishable.
 *
 * That is not a hypothetical here. `resolveThreadLink` walks UP a chain by
 * repeatedly reading `federation.in_reply_to` off a row it just wrote, and the
 * outbox path resolves the whole batch AFTER inserting it — so the links exist
 * only if each write is visible to the next read. A stubbed store makes that
 * true by construction. Real rows are the only place it is a claim.
 *
 * Both link columns are also real FOREIGN KEYS with `ON DELETE SET NULL`, so a
 * `parentPostId` pointing at a row that does not exist is not stored wrong — it
 * is not stored at all. Reading the columns back is the only way to see that.
 *
 * The REAL `PostCreationService` runs (registered through the service registry
 * exactly as it is in production), so the inbox path writes real rows too.
 * Network, crypto, media and Oxy stay mocked — they are the boundaries.
 */

const h = vi.hoisted(() => ({
  /** The real `PostCreationService`, captured when it registers itself. */
  creator: null as null | { create: (params: Record<string, unknown>) => Promise<unknown> },
  federateNewPost: vi.fn(async () => undefined),
  getPublicKey: vi.fn(),
  signRequest: vi.fn(),
  signViaOxy: vi.fn(),
  assertSafePublicUrl: vi.fn(),
  fetchUpstreamSingleHop: vi.fn(),
  fetchUpstreamFollowingRedirects: vi.fn(),
  persistRemoteMedia: vi.fn(),
  recordAccess: vi.fn(),
  getServiceOxyClient: vi.fn(),
}));

vi.mock('../../connectors/activitypub/crypto', () => ({
  getPublicKey: h.getPublicKey,
  signViaOxy: h.signViaOxy,
  signRequest: h.signRequest,
}));

vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  assertSafePublicUrl: h.assertSafePublicUrl,
}));

vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: h.getServiceOxyClient }));

vi.mock('../../utils/safeUpstreamFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/safeUpstreamFetch')>();
  return {
    ...actual,
    fetchUpstreamFollowingRedirects: h.fetchUpstreamFollowingRedirects,
    fetchUpstreamSingleHop: h.fetchUpstreamSingleHop,
  };
});

vi.mock('../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: h.persistRemoteMedia,
}));

vi.mock('../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: h.recordAccess,
}));

// The registry is the seam the connectors reach post creation through. Keeping
// the REAL creator behind it is the whole point: `getPostCreator().create` has
// to write a row the next resolution step can read back.
vi.mock('../../services/serviceRegistry', () => ({
  getPostCreator: () => {
    if (!h.creator) throw new Error('PostCreator not registered');
    return h.creator;
  },
  getPostFederator: () => ({ federateNewPost: h.federateNewPost }),
  registerPostCreator: (instance: { create: (params: Record<string, unknown>) => Promise<unknown> }) => {
    h.creator = instance;
  },
  registerPostFederator: vi.fn(),
}));

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn().mockResolvedValue([]) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollow,
} from '../helpers/federationFixtures';
// Importing the service is what registers it with the (mocked) registry above.
import '../../services/PostCreationService';
import { activityPubConnector as federationService } from '../../connectors/activitypub/ActivityPubConnector';
import backfillFederatedThreadLinks from '../../scripts/backfillFederatedThreadLinks';
import { insertPostRecord } from '../../db/posts/postRepository';
import { withDeadlockRetry } from '../helpers/serviceFixtures';
import { PostType, PostVisibility } from '@mention/shared-types';

const scope = federationScope('federation-thread-linking');
const ACTOR_URI = `${scope.origin}/users/alice`;
const AUTHOR_OXY = scope.user('alice');

/** The stored row for a federated post, looked up the way the code does. */
async function rowByActivityId(activityId: string) {
  const [row] = await getDb()
    .select({
      id: posts.id,
      parentPostId: posts.parentPostId,
      threadId: posts.threadId,
      isReply: posts.isReply,
      inReplyTo: posts.federationInReplyTo,
    })
    .from(posts)
    .where(eq(posts.federationActivityId, activityId));
  return row;
}

/**
 * Delete every post this suite's origin produced.
 *
 * Scoped by `federation_activity_id`, not by owner: the rows the code under test
 * writes are attributed to whatever `oxyUserId` the actor resolved to, and some
 * of them (backfilled ancestors) are created by production code that never saw
 * this scope. The activity id is the one handle every one of them carries.
 *
 * Two passes because these rows point at each other: the first clears every
 * link, so the second can delete them in any order without tripping a foreign
 * key or being silently set-null'd out from under itself.
 *
 * Both passes go through {@link withDeadlockRetry}, and that is not belt-and-
 * braces. `posts` self-references itself four times — `parent_post_id`,
 * `thread_id` and `quote_of` are `ON DELETE SET NULL`, `boost_of` cascades — so
 * a bulk delete takes locks well beyond the rows it names, and ten suites write
 * and delete `posts` concurrently against one database. Measured here: a plain
 * delete lost a `40P01` on roughly one full run in three, and it surfaced as
 * THIS suite failing in a test that had nothing to do with cleanup. The shared
 * `serviceFixtures` helpers have carried this retry from the start; this file
 * predates them and had its own cleanup, which is how it missed it.
 */
async function clearScopePosts(): Promise<void> {
  const db = getDb();
  await withDeadlockRetry(() =>
    db
      .update(posts)
      .set({ parentPostId: null, threadId: null, boostOf: null, quoteOf: null })
      .where(like(posts.federationActivityId, `${scope.origin}%`)),
  );
  await withDeadlockRetry(() =>
    db.delete(posts).where(like(posts.federationActivityId, `${scope.origin}%`)),
  );
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
    ...init,
  });
}

/**
 * A Create activity wrapping a Note (optionally a reply).
 *
 * `base` is the activity-id namespace the Note is minted in. It defaults to the
 * actor's own `/statuses`, which every case sharing ids with no other case uses;
 * the ancestor-boundary cases pass their own (see `caseNamespace` below).
 */
function replyCreateActivity(id: string, inReplyTo?: string, base = `${ACTOR_URI}/statuses`) {
  const note: Record<string, unknown> = {
    id: `${base}/${id}`,
    type: 'Note',
    attributedTo: ACTOR_URI,
    content: `<p>post ${id}</p>`,
    published: '2026-06-18T12:00:00Z',
    to: ['https://www.w3.org/ns/activitystreams#Public'],
  };
  if (inReplyTo) note.inReplyTo = inReplyTo;
  return {
    id: `${base}/${id}/activity`,
    type: 'Create',
    actor: ACTOR_URI,
    published: '2026-06-18T12:00:00Z',
    object: note,
  };
}

beforeAll(async () => {
  await connectPostgres();
});

// Cleanup runs in `beforeEach` as well as `afterEach`, and that is load-bearing:
// the reconciliation test drives the REAL script, whose
// `closeAdminScriptResources()` closes the Postgres pool on purpose (a Fargate
// one-shot has to exit). Its own hooks reconnect, but a stale row from a
// previous test would otherwise be swept up by the script's global query.
afterAll(async () => {
  await connectPostgres();
  await clearScopePosts();
  await clearFederationScope(scope);
  await closePostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  // The script under test in the last describe closes the pool; reopen so the
  // ordering of the describes cannot decide whether the suite runs.
  await connectPostgres();
  await clearScopePosts();
  await clearFederationScope(scope);

  h.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/instance#main-key',
    publicKeyPem: 'public',
  });
  h.signViaOxy.mockResolvedValue('signature');
  h.signRequest.mockResolvedValue({ Signature: 'signature' });

  // Default: the outbox owner is a known, fresh federated actor followed by a
  // local user, so both the resolution and the follower gate pass.
  await seedActor(scope, {
    username: 'alice',
    uri: ACTOR_URI,
    oxyUserId: AUTHOR_OXY,
    lastFetchedAt: new Date(),
  });
  await seedFollow(scope, { remoteActorUri: ACTOR_URI, direction: 'outbound', status: 'accepted' });
  h.assertSafePublicUrl.mockResolvedValue({ ok: true, ip: '93.184.216.34', family: 4 });
  h.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  h.recordAccess.mockResolvedValue(undefined);
  h.getServiceOxyClient.mockReturnValue({
    makeServiceRequest: vi.fn(),
    getUserById: vi.fn(async () => ({ id: AUTHOR_OXY, username: 'alice' })),
    getUsersByIds: vi.fn(async () => []),
  });

  // signedFetch is built on fetchUpstreamSingleHop; adapt it to the per-test
  // stubbed global fetch.
  h.fetchUpstreamSingleHop.mockImplementation(
    async (url: string, options: { headers: Record<string, string>; method?: string; body?: BodyInit }) => {
      const res: Response = await (globalThis.fetch as typeof fetch)(url, {
        headers: options.headers,
        method: options.method,
        body: options.body,
      });
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

afterEach(async () => {
  vi.unstubAllEnvs();
  await connectPostgres();
  await clearScopePosts();
  await clearFederationScope(scope);
});

describe('inbox handleCreate — reply linking', () => {
  it('links parentPostId + threadId when the parent is already local', async () => {
    // Pre-existing imported federated parent, a thread root (threadId unset).
    const parentUri = `${ACTOR_URI}/statuses/100`;
    const parent = await insertPostRecord({
      oxyUserId: AUTHOR_OXY,
      authorship: [{ oxyUserId: AUTHOR_OXY, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'the parent', tag: 'en' }] },
      federation: { activityId: parentUri, actorUri: ACTOR_URI },
    });
    expect(parent.threadId).toBeNull();

    await federationService.processInboxActivity(replyCreateActivity('101', parentUri), ACTOR_URI);

    const reply = await rowByActivityId(`${ACTOR_URI}/statuses/101`);
    expect(reply).toBeDefined();
    expect(reply?.parentPostId).toBe(parent.id);
    // threadId = parent.threadId ?? parent.id → the root id (the native rule).
    expect(reply?.threadId).toBe(parent.id);
    expect(reply?.inReplyTo).toBe(parentUri);
    // The stored discriminator, which is what every feed query reads — a link
    // that landed while `is_reply` stayed false would promote the reply into For
    // You / Following / Explore.
    expect(reply?.isReply).toBe(true);
  });

  it('stores a non-reply post with null parentPostId/threadId', async () => {
    await federationService.processInboxActivity(replyCreateActivity('200'), ACTOR_URI);

    const row = await rowByActivityId(`${ACTOR_URI}/statuses/200`);
    expect(row).toBeDefined();
    expect(row?.parentPostId).toBeNull();
    expect(row?.threadId).toBeNull();
    expect(row?.isReply).toBe(false);
  });
});

describe('outbox backfill — self-thread linking (the path that used to DROP replies)', () => {
  const outboxUrl = `${ACTOR_URI}/outbox`;
  const firstPageUrl = `${ACTOR_URI}/outbox?page=true`;

  /**
   * Serve a self-thread 1→2→3→4 in REVERSE (newest-first) order — the order a
   * real Mastodon outbox page returns — to prove the linking is independent of
   * intra-batch insertion order.
   */
  function stubSelfThreadOutbox() {
    const items = [
      replyCreateActivity('4', `${ACTOR_URI}/statuses/3`),
      replyCreateActivity('3', `${ACTOR_URI}/statuses/2`),
      replyCreateActivity('2', `${ACTOR_URI}/statuses/1`),
      replyCreateActivity('1'),
    ];
    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 4, first: firstPageUrl });
      }
      if (url === firstPageUrl) {
        return jsonResponse({ type: 'OrderedCollectionPage', id: firstPageUrl, orderedItems: items });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('imports the actor self-replies and links them all into ONE thread', async () => {
    stubSelfThreadOutbox();

    const result = await federationService.syncOutboxPostsDetailed(
      { uri: ACTOR_URI, acct: 'alice@mastodon.social', outboxUrl, oxyUserId: AUTHOR_OXY },
      { limit: 10, maxPages: 1 },
    );

    // All four notes imported (replies are no longer dropped).
    expect(result.newPostCount).toBe(4);

    const root = await rowByActivityId(`${ACTOR_URI}/statuses/1`);
    const r2 = await rowByActivityId(`${ACTOR_URI}/statuses/2`);
    const r3 = await rowByActivityId(`${ACTOR_URI}/statuses/3`);
    const r4 = await rowByActivityId(`${ACTOR_URI}/statuses/4`);
    expect([root, r2, r3, r4].every(Boolean)).toBe(true);

    // Root: no parent, no threadId (native top-level post semantics).
    expect(root?.parentPostId).toBeNull();
    expect(root?.threadId).toBeNull();
    expect(root?.isReply).toBe(false);

    // Each reply points at its immediate parent…
    expect(r2?.parentPostId).toBe(root?.id);
    expect(r3?.parentPostId).toBe(r2?.id);
    expect(r4?.parentPostId).toBe(r3?.id);

    // …and EVERY reply shares the SAME thread root id, regardless of the
    // newest-first import order. These are real foreign keys, so a link naming a
    // row that was never written would not be stored at all.
    expect(r2?.threadId).toBe(root?.id);
    expect(r3?.threadId).toBe(root?.id);
    expect(r4?.threadId).toBe(root?.id);
    for (const reply of [r2, r3, r4]) expect(reply?.isReply).toBe(true);
  });
});

describe('outbox backfill — bounded ancestor backfill', () => {
  const outboxUrl = `${ACTOR_URI}/outbox`;
  const firstPageUrl = `${ACTOR_URI}/outbox?page=true`;

  /**
   * The ancestor-walking cases below each import THIRTY posts — thirty fetches
   * and thirty real writes against a database ten worker processes share.
   * Measured here: ~0.8s each on an idle machine, ~3.5s each with one other
   * suite running against the same server, which is 1.4x off the default 5s.
   *
   * That default is therefore a bound on how loaded the machine is rather than
   * on anything these cases are testing — what they assert about the walk is
   * asserted explicitly, by counting fetches and materialised rows. CI hit it
   * (`Test timed out in 5000ms`, green on re-run), and a timeout here does not
   * stop at failing its own case: see `caseNamespace` for what the abandoned
   * work then does to the NEXT one.
   */
  const CHAIN_WALK_TIMEOUT_MS = 30_000;

  /**
   * A private activity-id namespace for ONE case, and the reason every chain
   * case below owns one.
   *
   * These cases used to number their chains from 1 inside the FILE-wide
   * `${ACTOR_URI}/statuses/` namespace, and two of them then COUNT what a single
   * pass materialised — over that same file-wide prefix. The counts therefore
   * spanned each other almost completely (1..31 against 2..32), so a row
   * surviving from a sibling case was indistinguishable from an ancestor of this
   * one. `31` — the value CI reported against an expected `30` — is exactly that
   * shape.
   *
   * A surviving row is reachable, and not through sloppy cleanup:
   * `clearScopePosts` runs in `beforeEach` AND `afterEach`, and the code under
   * test detaches nothing — `processInboxActivity` awaits the whole ancestor
   * backfill. **Vitest does not cancel a timed-out test's work.** When the TEST
   * times out, vitest fails it and moves on while that awaited chain keeps
   * writing, straight through both cleanups and into the next case.
   *
   * Measured, by capping the infinite-chain case at 400ms: it times out, and the
   * next case counts 38 ancestors instead of 30 — CI's two failures, which
   * arrived one per run, reproduced together in one run.
   *
   * Hence three parts, and each is load-bearing: `CHAIN_WALK_TIMEOUT_MS` removes
   * the mechanism; a namespace per case makes a straggler's rows UNCOUNTABLE by
   * anyone else; and each chain's fetch stub REFUSES a URL outside its own
   * namespace. That last one is not tidiness — the stub is `globalThis.fetch`,
   * so a straggler's next ancestor fetch is served by whichever case is running
   * NOW. Left permissive, the new case answers with a Note in ITS namespace and
   * the straggler materialises ancestors the running case then counts: measured
   * at 47 with the namespaces in place and the stub still permissive.
   */
  const caseNamespace = (caseName: string) => `${ACTOR_URI}/${caseName}/statuses`;

  /**
   * The ancestor number in `base`'s namespace, or null for any other URL — which
   * every chain stub below refuses.
   */
  const ancestorNumber = (base: string, url: string): number | null => {
    if (!url.startsWith(`${base}/`)) return null;
    const n = Number(url.slice(base.length + 1));
    return Number.isInteger(n) ? n : null;
  };

  /**
   * Ancestor fetches this case's OWN chain was asked for.
   *
   * Filtered for the same reason the row counts are, and it is the same stub
   * that makes it necessary: a straggler's next fetch is RECORDED by whichever
   * case's spy is installed now. Refusing it stops the rows but not the call —
   * measured at 32 against an expected 30, on a case that did nothing wrong.
   *
   * Nothing real is lost. Every URL this walk can reach is one this stub minted,
   * so a fetch outside the namespace is not something the code under test can
   * do; if it somehow did, the stub refuses it and the shortfall lands on the
   * row count instead.
   */
  const ancestorFetches = (
    fetchMock: Mock<(url: string) => Promise<Response>>,
    base: string,
  ): number => fetchMock.mock.calls.filter(([url]) => url.startsWith(`${base}/`)).length;

  it('fetches + imports a NON-local parent and links the reply to it', async () => {
    const parentUri = `${ACTOR_URI}/statuses/500`;
    const replyActivity = replyCreateActivity('501', parentUri);

    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 1, first: firstPageUrl });
      }
      if (url === firstPageUrl) {
        return jsonResponse({
          type: 'OrderedCollectionPage',
          id: firstPageUrl,
          orderedItems: [replyActivity],
        });
      }
      // The parent Note is NOT stored — it is fetched on demand.
      if (url === parentUri) {
        return jsonResponse({
          id: parentUri,
          type: 'Note',
          attributedTo: ACTOR_URI,
          content: '<p>the ancestor</p>',
          to: ['https://www.w3.org/ns/activitystreams#Public'],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await federationService.syncOutboxPostsDetailed(
      { uri: ACTOR_URI, acct: 'alice@mastodon.social', outboxUrl, oxyUserId: AUTHOR_OXY },
      { limit: 10, maxPages: 1 },
    );

    // Parent was fetched on demand and stored.
    expect(fetchMock).toHaveBeenCalledWith(parentUri, expect.anything());
    const parent = await rowByActivityId(parentUri);
    expect(parent).toBeDefined();

    // The reply is linked to the backfilled parent, which is the thread root.
    const reply = await rowByActivityId(`${ACTOR_URI}/statuses/501`);
    expect(reply?.parentPostId).toBe(parent?.id);
    expect(reply?.threadId).toBe(parent?.id);
  });

  it('respects the depth cap on an infinite ancestor chain (no runaway, reply still linked)', async () => {
    const base = caseNamespace('infinite-chain');
    // Every fetched status N is a reply to status N+1 — an unbounded ascending
    // chain. The depth cap must terminate the backfill.
    const fetchMock = vi.fn(async (url: string) => {
      const n = ancestorNumber(base, url);
      if (n === null) throw new Error(`unexpected fetch ${url}`);
      return jsonResponse({
        id: url,
        type: 'Note',
        attributedTo: ACTOR_URI,
        content: `<p>ancestor ${n}</p>`,
        inReplyTo: `${base}/${n + 1}`,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Inbox reply whose parent starts the infinite chain.
    await federationService.processInboxActivity(
      replyCreateActivity('1000', `${base}/1001`, base),
      ACTOR_URI,
    );

    // Terminated (the test did not hang) and bounded: the on-demand parent
    // fetches never exceed the depth cap (30) by more than a small constant.
    expect(ancestorFetches(fetchMock, base)).toBeLessThanOrEqual(32);

    // The original reply is still stored (best-effort) and linked to its
    // immediate parent, which was itself imported by the backfill.
    const reply = await rowByActivityId(`${base}/1000`);
    const immediateParent = await rowByActivityId(`${base}/1001`);
    expect(reply).toBeDefined();
    expect(immediateParent).toBeDefined();
    expect(reply?.parentPostId).toBe(immediateParent?.id);
  }, CHAIN_WALK_TIMEOUT_MS);

  /**
   * How much of a thread ONE ingest pass will pull.
   *
   * `MAX_ANCESTOR_DEPTH` (30) is the pre-existing and still the BINDING bound on
   * live thread ingest: `handleCreate` is the only live entry point that walks a
   * reply chain (via `ensureFederatedReplyLink`), each level has exactly one
   * `inReplyTo`, so the walk is linear and one inbound reply materialises at most
   * that many ancestors. Nothing walks `replies`/`context` collections, so there is
   * no descendant fan-out at all; the outbox path is separately bounded by its own
   * candidate limit, page budget and per-page inspection cap.
   *
   * The measured pile-up (annihilation.social, 1,820 ancestors) is far past this,
   * which is exactly why it needs pinning at the boundary rather than at a "no
   * runaway" order of magnitude: these assert the number of ancestors ACTUALLY
   * MATERIALISED, so a regression that loosens the walk shows up as a count, not as
   * a hang.
   */
  describe('per-pass ancestor materialisation boundary', () => {
    /**
     * `length` ancestors above the inbound reply, ending at a real root, minted
     * in `base`. Returns the fetch mock so the caller can count on-demand
     * ancestor fetches.
     */
    const finiteChain = (base: string, length: number) => {
      // <base>/1 is the root; <base>/N replies to <base>/N-1. The inbound reply
      // is <base>/(length + 1), so `length` ancestors sit above it.
      const fetchMock = vi.fn(async (url: string) => {
        const n = ancestorNumber(base, url);
        if (n === null) throw new Error(`unexpected fetch ${url}`);
        return jsonResponse({
          id: url,
          type: 'Note',
          attributedTo: ACTOR_URI,
          content: `<p>ancestor ${n}</p>`,
          ...(n > 1 ? { inReplyTo: `${base}/${n - 1}` } : {}),
          to: ['https://www.w3.org/ns/activitystreams#Public'],
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };

    /**
     * Ancestor posts this pass actually WROTE, counted from the rows in the
     * calling case's OWN namespace (excludes the inbound reply itself).
     *
     * Counted from `posts` rather than from a creator spy, because the spy
     * answers "how many creates were attempted" and the boundary is about how
     * many ancestors EXIST afterwards — a create that lost a unique race on
     * `federation_activity_id` attempted and stored nothing.
     */
    const materialisedAncestors = async (
      base: string,
      replyActivityId: string,
    ): Promise<number> => {
      const rows = await getDb()
        .select({ activityId: posts.federationActivityId })
        .from(posts)
        .where(and(
          like(posts.federationActivityId, `${base}/%`),
          ne(posts.federationActivityId, replyActivityId),
        ));
      return rows.length;
    };

    it('pulls a whole 30-ancestor chain — AT the depth cap nothing is left behind', async () => {
      const base = caseNamespace('chain-of-30');
      const fetchMock = finiteChain(base, 30);

      await federationService.processInboxActivity(
        replyCreateActivity('31', `${base}/30`, base),
        ACTOR_URI,
      );

      expect(await materialisedAncestors(base, `${base}/31`)).toBe(30);
      expect(ancestorFetches(fetchMock, base)).toBe(30);
      // Reached the real root, so the reply carries the true thread id.
      const root = await rowByActivityId(`${base}/1`);
      expect(root).toBeDefined();
      const reply = await rowByActivityId(`${base}/31`);
      expect(reply?.threadId).toBe(root?.id);
    }, CHAIN_WALK_TIMEOUT_MS);

    it('stops at 30 on a 31-ancestor chain — the reply still lands, unlinked above', async () => {
      const base = caseNamespace('chain-of-31');
      const fetchMock = finiteChain(base, 31);

      await federationService.processInboxActivity(
        replyCreateActivity('32', `${base}/31`, base),
        ACTOR_URI,
      );

      // One over the chain length the cap allows: the 31st ancestor (the real
      // root, <base>/1) is never fetched and never written.
      expect(await materialisedAncestors(base, `${base}/32`)).toBe(30);
      expect(ancestorFetches(fetchMock, base)).toBe(30);
      expect(fetchMock).not.toHaveBeenCalledWith(`${base}/1`, expect.anything());
      expect(await rowByActivityId(`${base}/1`)).toBeUndefined();

      // Best-effort, never a dropped post: the reply exists and is linked to its
      // immediate parent, rooted at the deepest ancestor the pass did reach.
      const reply = await rowByActivityId(`${base}/32`);
      expect(reply?.parentPostId).toBe((await rowByActivityId(`${base}/31`))?.id);
      expect(reply?.threadId).toBe((await rowByActivityId(`${base}/2`))?.id);
    }, CHAIN_WALK_TIMEOUT_MS);
  });
});

describe('reconciliation script — backfillFederatedThreadLinks', () => {
  it('links an already-imported orphan (inReplyTo set, parentPostId null)', async () => {
    vi.stubEnv('CONFIRM_ADMIN_MUTATION', 'backfillFederatedThreadLinks');

    const parentUri = `${ACTOR_URI}/statuses/700`;
    const base = {
      oxyUserId: AUTHOR_OXY,
      authorship: [{ oxyUserId: AUTHOR_OXY, role: 'owner' as const, status: 'accepted' as const }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published' as const,
    };
    // Local parent (thread root) + an orphaned reply pointing at it.
    const parent = await insertPostRecord({
      ...base,
      content: { variants: [{ source: 'author', text: 'the parent', tag: 'en' }] },
      federation: { activityId: parentUri, actorUri: ACTOR_URI },
    });
    const orphan = await insertPostRecord({
      ...base,
      content: { variants: [{ source: 'author', text: 'the orphan', tag: 'en' }] },
      federation: {
        activityId: `${ACTOR_URI}/statuses/701`,
        actorUri: ACTOR_URI,
        inReplyTo: parentUri,
      },
    });
    // The orphan state the script exists to repair is LEGITIMATE and storable:
    // `is_reply` true with no parent link.
    expect(orphan.isReply).toBe(true);
    expect(orphan.parentPostId).toBeNull();

    // A non-orphan (already linked) — must be left untouched.
    const linked = await insertPostRecord({
      ...base,
      content: { variants: [{ source: 'author', text: 'already linked', tag: 'en' }] },
      parentPostId: parent.id,
      threadId: parent.id,
      federation: {
        activityId: `${ACTOR_URI}/statuses/702`,
        actorUri: ACTOR_URI,
        inReplyTo: parentUri,
      },
    });

    await backfillFederatedThreadLinks();

    // The script closes the pool on purpose (it is a Fargate one-shot).
    await connectPostgres();

    const repaired = await rowByActivityId(`${ACTOR_URI}/statuses/701`);
    expect(repaired?.parentPostId).toBe(parent.id);
    expect(repaired?.threadId).toBe(parent.id);

    // The already-linked reply is unchanged, and the parent was not turned into
    // a reply of itself.
    const untouched = await rowByActivityId(`${ACTOR_URI}/statuses/702`);
    expect(untouched?.id).toBe(linked.id);
    expect(untouched?.parentPostId).toBe(parent.id);
    expect(untouched?.threadId).toBe(parent.id);
    const parentRow = await rowByActivityId(parentUri);
    expect(parentRow?.parentPostId).toBeNull();
  });
});
