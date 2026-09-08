import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A quote imported through the OUTBOX BACKFILL, and through the boost / ancestor
 * / quoted-note importer underneath it.
 *
 * `extractApQuoteUri` and `ensureQuotedNote` existed, and only `handleCreate`
 * ever called them. So whether a reader saw a quote depended on WHICH PATH
 * happened to import the post:
 *
 *  - delivered live to our inbox  → `quote_of` set, quote card rendered;
 *  - pulled from the actor's outbox (how a newly-followed account's back
 *    catalogue arrives) → `quote_of` NULL, and the body left showing the remote
 *    server's fallback rendering, a bare `RE: <url>` line;
 *  - fetched as a boost original or a reply ancestor → `quote_of` NULL likewise.
 *
 * Two accounts on the same remote instance therefore rendered differently, and
 * so did one account before and after it was followed. Which path imported a
 * post is not something a reader can see, so it must not be something they can
 * feel.
 *
 * The posts are REAL ROWS and every assertion reads the STORED post. This path
 * does not go through `PostCreationService` at all — it assembles records and
 * writes them straight through the repository — so "the service was called with
 * a quoteOf" would assert nothing about what is in the database, and `type` in
 * particular is derived by the row builder rather than by the service.
 *
 * Driven through the real entry point (`syncOutboxPostsDetailed`) on the harness
 * `channelReplyOutboxBackfill.test.ts` established.
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

import { and, eq, like } from 'drizzle-orm';
import { PostType } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { postContentVariants } from '../../../db/schema/postContent';
import {
  clearFederationScope,
  federationScope,
  seedPost,
} from '../../helpers/federationFixtures';
import { outboxSyncService } from '../../../connectors/activitypub/outbox.service';

const scope = federationScope('outbox-quote-linking');
const ACTOR_URI = `${scope.origin}/users/alice`;
const OUTBOX_URL = `${ACTOR_URI}/outbox`;
const ALICE_OXY_ID = scope.user('alice');

/** The author of everything Alice quotes — a second actor on the same instance. */
const BOB_URI = `${scope.origin}/users/bob`;
const BOB_OXY_ID = scope.user('bob');
/** A post by Bob that we ALREADY hold. */
const HELD_URI = `${BOB_URI}/statuses/held`;
/** A post by Bob that we do NOT hold, and must fetch. */
const UNHELD_URI = `${BOB_URI}/statuses/unheld`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
  });
}

/**
 * One Create/Note in Alice's outbox.
 *
 * `quote` alone, deliberately: it is the FEP-044f field Mastodon 4.4 emits, and
 * `apQuoteExtraction.test.ts` already pins that the other spellings resolve to
 * the same URI. Pinning one here keeps this file about the ingest PATH.
 */
function createNote(id: string, extra: Record<string, unknown> = {}) {
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
      // The body a real quote arrives with: the remote server renders the quote
      // as `RE: <url>` for clients that cannot show one. It is the SYMPTOM this
      // whole file is about, and it is deliberately present in the fixture so
      // nothing here can be read as "the body was different".
      content: `<p>RE: ${HELD_URI}</p>`,
      published: '2023-04-01T12:00:00Z',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      ...extra,
    },
  };
}

/** A Note as Bob's server would serve it when we go and fetch it. */
function bobNote(uri: string, extra: Record<string, unknown> = {}) {
  return {
    id: uri,
    type: 'Note',
    attributedTo: BOB_URI,
    content: '<p>bob said something</p>',
    published: '2023-03-01T12:00:00Z',
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    ...extra,
  };
}

/** Serve Alice's outbox page, plus whatever remote objects a case publishes. */
function stubRemote(orderedItems: unknown[], objects: Record<string, unknown> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === OUTBOX_URL || url === THREADS_OUTBOX) {
        return jsonResponse({ type: 'OrderedCollection', totalItems: orderedItems.length, orderedItems });
      }
      const object = objects[url];
      if (object) return jsonResponse(object);
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

/** The markup Threads actually emits — its ONLY carrier for a quote. */
function threadsQuoteBody(target: string): string {
  return `<p>A M A T E R A S U 👁️ 🔥</p> <p><span class="quote-inline">RE: <a href="${target}">${target}</a></span></p>`;
}

/** A Threads Create/Note, from a threads.net actor rather than this suite's own. */
const THREADS_ACTOR = 'https://threads.net/ap/users/17841401260928433';
const THREADS_OUTBOX = `${THREADS_ACTOR}/outbox/`;
const THREADS_OXY_ID = scope.user('threads');
function threadsNote(id: string, target: string) {
  const noteId = `${THREADS_ACTOR}/post/${id}`;
  return {
    id: `${noteId}/activity`,
    type: 'Create',
    actor: THREADS_ACTOR,
    published: '2023-04-01T12:00:00Z',
    object: {
      id: noteId,
      type: 'Note',
      attributedTo: THREADS_ACTOR,
      content: threadsQuoteBody(target),
      published: '2023-04-01T12:00:00Z',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
}

/** Sync the THREADS actor's own outbox — the host gate reads the outbox owner. */
function runThreadsOutboxSync() {
  return outboxSyncService.syncOutboxPostsDetailed(
    { uri: THREADS_ACTOR, acct: 'someone@threads.net', outboxUrl: THREADS_OUTBOX, oxyUserId: THREADS_OXY_ID },
    { limit: 10, maxPages: 1 },
  );
}

function runOutboxSync() {
  return outboxSyncService.syncOutboxPostsDetailed(
    { uri: ACTOR_URI, acct: `alice@${scope.domain}`, outboxUrl: OUTBOX_URL, oxyUserId: ALICE_OXY_ID },
    { limit: 10, maxPages: 1 },
  );
}

/** The stored row for one of Alice's notes, by the local part of its id. */
/** The stored PRIMARY body of one of Alice's notes. */
async function storedBody(id: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ body: postContentVariants.body })
    .from(posts)
    .innerJoin(
      postContentVariants,
      and(eq(postContentVariants.postId, posts.id), eq(postContentVariants.position, 0)),
    )
    .where(like(posts.federationActivityId, `${ACTOR_URI}/statuses/${id}%`));
  return row?.body;
}

async function storedNote(
  id: string,
): Promise<{ quoteOf: string | null; type: string; status: string } | undefined> {
  const [row] = await getDb()
    .select({ quoteOf: posts.quoteOf, type: posts.type, status: posts.status })
    .from(posts)
    .where(like(posts.federationActivityId, `${ACTOR_URI}/statuses/${id}%`));
  return row;
}

/** The stored row for a note of Bob's we imported by fetching it. */
async function storedRemote(uri: string): Promise<{ id: string; quoteOf: string | null } | undefined> {
  const [row] = await getDb()
    .select({ id: posts.id, quoteOf: posts.quoteOf })
    .from(posts)
    .where(like(posts.federationActivityId, `${uri}%`));
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  await getDb().delete(posts).where(like(posts.federationActivityId, `${ACTOR_URI}%`));
  await getDb().delete(posts).where(like(posts.federationActivityId, `${BOB_URI}%`));
  await getDb().delete(posts).where(like(posts.federationActivityId, `${THREADS_ACTOR}%`));
  await clearFederationScope(scope);
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();

  mocks.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/instance#main-key',
    publicKeyPem: 'public',
  });
  mocks.signViaOxy.mockResolvedValue('c2lnbmF0dXJl');
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.postCreatorCreate.mockResolvedValue({ id: 'created_post_1' });
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
  // Both actors on the instance resolve, so a case that fails to link a quote
  // fails because of the quote and not because the author was unresolvable.
  mocks.getOrFetchActor.mockImplementation(async (uri: string) => {
    if (uri === BOB_URI) return { uri: BOB_URI, oxyUserId: BOB_OXY_ID, type: 'Person' };
    if (uri === THREADS_ACTOR) {
      return { uri: THREADS_ACTOR, oxyUserId: THREADS_OXY_ID, type: 'Person', domain: 'threads.net' };
    }
    return { uri: ACTOR_URI, oxyUserId: ALICE_OXY_ID, type: 'Person' };
  });
});

describe('outbox backfill — a quote is linked, not left as `RE: <url>`', () => {
  it('links a quote of a post we already hold, and types the row as a quote', async () => {
    const quoted = await seedPost(scope, {
      oxyUserId: BOB_OXY_ID,
      federation: { activityId: HELD_URI, actorUri: BOB_URI },
    });
    stubRemote([createNote('quoting', { quote: HELD_URI })]);

    await runOutboxSync();

    expect(await storedNote('quoting')).toEqual({
      quoteOf: quoted.id,
      type: PostType.QUOTE,
      status: 'published',
    });
  });

  it('CONTROL: a note with the same `RE:` body but no quote field links nothing', async () => {
    // Two things at once, and the file needs both.
    //
    // Same page, same path, opposite outcome — which is what stops the case
    // above from being a check that cannot fail: a `quote_of` filled
    // unconditionally would pass every other assertion here.
    //
    // And the quoted post IS SEEDED, so `null` means "we held it and still did
    // not link it", not "the lookup missed". Every fixture in this file carries
    // `RE: <url>` in its body, so without that the pass above could have come
    // from parsing the body — which is precisely what must not happen. The body
    // is how a remote server RENDERS a quote, not where the quote lives.
    await seedPost(scope, {
      oxyUserId: BOB_OXY_ID,
      federation: { activityId: HELD_URI, actorUri: BOB_URI },
    });
    stubRemote([createNote('plain')]);

    await runOutboxSync();

    expect(await storedNote('plain')).toEqual({
      quoteOf: null,
      type: PostType.TEXT,
      status: 'published',
    });
  });

  it('fetches and imports a quoted post we do NOT hold, then links it', async () => {
    // The case the reader actually hits: you follow an account and its back
    // catalogue quotes people you have never held a post from. Nothing in this
    // path used to fetch, so every one of those quotes stayed null forever —
    // there is no later pass that revisits an imported post.
    stubRemote(
      [createNote('quoting-unheld', { quote: UNHELD_URI })],
      { [UNHELD_URI]: bobNote(UNHELD_URI) },
    );

    await runOutboxSync();

    const imported = await storedRemote(UNHELD_URI);
    expect(imported).toBeDefined();
    expect(await storedNote('quoting-unheld')).toEqual({
      quoteOf: imported?.id,
      type: PostType.QUOTE,
      status: 'published',
    });
  });

  it('links the quote carried by the FETCHED post too, not just the top one', async () => {
    // `ensureFederatedNote` is the importer behind a boost original, a reply
    // ancestor AND a quoted note, and it had the same blind spot: whatever it
    // imported lost its own quote. So a quote of a quote linked the first hop
    // and dropped the second.
    const held = await seedPost(scope, {
      oxyUserId: BOB_OXY_ID,
      federation: { activityId: HELD_URI, actorUri: BOB_URI },
    });
    stubRemote(
      [createNote('quoting-chain', { quote: UNHELD_URI })],
      { [UNHELD_URI]: bobNote(UNHELD_URI, { quote: HELD_URI }) },
    );

    await runOutboxSync();

    const middle = await storedRemote(UNHELD_URI);
    expect(middle?.quoteOf).toBe(held.id);
    expect((await storedNote('quoting-chain'))?.quoteOf).toBe(middle?.id);
  });
});

describe('a quote we cannot produce withholds the post instead of showing `RE:`', () => {
  it('stores a note whose declared quote does not resolve as `incomplete`', async () => {
    // The quoted URI is a real AP id and the fetch fails, so nothing can link
    // it. The author's text was written ABOUT that post; published, the reader
    // gets half a conversation plus the remote server's `RE: <url>` fallback.
    stubRemote([createNote('unresolvable', { quote: UNHELD_URI })]);

    await runOutboxSync();

    expect(await storedNote('unresolvable')).toEqual({
      quoteOf: null,
      type: PostType.TEXT,
      status: 'incomplete',
    });
  });

  it('CONTROL: a note that quotes NOTHING is still published', async () => {
    // Without this the case above would pass just as well if the ingest had
    // started withholding every federated note.
    stubRemote([createNote('no-quote')]);

    await runOutboxSync();

    expect((await storedNote('no-quote'))?.status).toBe('published');
  });
});

describe("Threads, whose quote exists ONLY as `span.quote-inline`", () => {
  /** The stored row for a Threads note, which lives under a different actor. */
  async function storedThreadsNote(id: string) {
    const [row] = await getDb()
      .select({ quoteOf: posts.quoteOf, status: posts.status })
      .from(posts)
      .where(like(posts.federationActivityId, `${THREADS_ACTOR}/post/${id}%`));
    return row;
  }

  it('links the quote when we already hold the post, matching on its NOTE URL', async () => {
    // Threads names its quote by `www.threads.com` web URL, never by AP id — so
    // `federation_url` is the only column that can ever match it. Measured on
    // the live server: the AP object carries no quote field at all.
    const target = 'https://www.threads.com/@someone/post/DctgllSGf_L';
    const quoted = await seedPost(scope, {
      oxyUserId: BOB_OXY_ID,
      federation: { activityId: `${THREADS_ACTOR}/post/999`, actorUri: THREADS_ACTOR, url: target },
    });
    stubRemote([threadsNote('held-quote', target)]);

    await runThreadsOutboxSync();

    expect(await storedThreadsNote('held-quote')).toEqual({
      quoteOf: quoted.id,
      status: 'published',
    });
  });

  it('withholds it when we do not hold the post, and never fetches the web URL', async () => {
    // The href is a WEB url: it serves text/html even to a signed request, and
    // the shortcode decodes into a different id space, so there is nothing to
    // fetch. `stubRemote` throws on any unexpected URL, which is what proves the
    // fetch was not attempted.
    stubRemote([threadsNote('unheld-quote', 'https://www.threads.com/@nobody/post/DcXXXXXXXXX')]);

    await runThreadsOutboxSync();

    expect(await storedThreadsNote('unheld-quote')).toEqual({
      quoteOf: null,
      status: 'incomplete',
    });
  });

  it('does NOT read that markup from a non-Threads server', async () => {
    // The host gate is the whole reason reading this body is defensible: the
    // class is markup Threads emits, and only there is it known to mean a quote.
    // A Mastodon note carrying the same span is left completely alone.
    stubRemote([createNote('lookalike', {
      content: threadsQuoteBody('https://www.threads.com/@someone/post/DctgllSGf_L'),
    })]);

    await runOutboxSync();

    expect(await storedNote('lookalike')).toEqual({
      quoteOf: null,
      type: PostType.TEXT,
      status: 'published',
    });
  });
});

describe("the remote's `RE:` fallback goes once we can render the quote ourselves", () => {
  it('is removed from the stored body when the quote LINKS', async () => {
    // Production had 16,158 of 16,324 linked quotes showing the card AND a raw
    // duplicate of the same link, because the marker was never taken out.
    const quoted = await seedPost(scope, {
      oxyUserId: BOB_OXY_ID,
      federation: { activityId: HELD_URI, actorUri: BOB_URI, url: HELD_URI },
    });
    stubRemote([createNote('linked-marker', { quote: HELD_URI })]);

    await runOutboxSync();

    expect((await storedNote('linked-marker'))?.quoteOf).toBe(quoted.id);
    expect(await storedBody('linked-marker')).not.toContain('RE:');
  });

  it('SURVIVES when the quote does not link, because it is the only reference', async () => {
    // The withheld post keeps the marker: nothing renders it, and throwing the
    // reference away would leave no pointer at all if it is ever promoted.
    // The marker must name the SAME url the note declares, or this case would
    // pass because the two simply did not match — which is what a mutation run
    // caught: forcing the strip unconditionally left it green.
    stubRemote([createNote('unlinked-marker', {
      quote: UNHELD_URI,
      content: `<p>RE: ${UNHELD_URI}</p>`,
    })]);

    await runOutboxSync();

    expect((await storedNote('unlinked-marker'))?.status).toBe('incomplete');
    expect(await storedBody('unlinked-marker')).toContain('RE:');
  });
});

describe('a bridge-flattened retweet is dropped on THIS path too, not only the inbox', () => {
  /**
   * `dropFlattenedRetweets` was passed by `handleCreate` and by nothing else, so
   * the same Note was kept or discarded depending only on which route imported
   * it — the identical three-path asymmetry #905 fixed for quotes. Measured in
   * production: 934 stored posts whose body opens `RT:`, 794 of them from ONE
   * reviewed bridge (mastox.eu), each appearing under a byline that did not
   * write it with a dead `@handle` and no route to the real author.
   */
  const BRIDGE_ACTOR = 'https://bird.makeup/users/someone';
  const BRIDGE_OUTBOX = `${BRIDGE_ACTOR}/outbox`;
  const BRIDGE_OXY_ID = scope.user('bridge');

  function bridgeNote(id: string, body: string) {
    const noteId = `${BRIDGE_ACTOR}/statuses/${id}`;
    return {
      id: `${noteId}/activity`,
      type: 'Create',
      actor: BRIDGE_ACTOR,
      published: '2023-04-01T12:00:00Z',
      object: {
        id: noteId,
        type: 'Note',
        attributedTo: BRIDGE_ACTOR,
        content: `<p>${body}</p>`,
        published: '2023-04-01T12:00:00Z',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
      },
    };
  }

  function stubBridgeOutbox(items: unknown[]): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === BRIDGE_OUTBOX) {
        return jsonResponse({ type: 'OrderedCollection', totalItems: items.length, orderedItems: items });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
  }

  async function runBridgeSync() {
    return outboxSyncService.syncOutboxPostsDetailed(
      { uri: BRIDGE_ACTOR, acct: 'someone@bird.makeup', outboxUrl: BRIDGE_OUTBOX, oxyUserId: BRIDGE_OXY_ID },
      { limit: 10, maxPages: 1 },
    );
  }

  async function storedCount(id: string): Promise<number> {
    const rows = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(like(posts.federationActivityId, `${BRIDGE_ACTOR}/statuses/${id}%`));
    return rows.length;
  }

  beforeEach(() => {
    mocks.getOrFetchActor.mockImplementation(async (uri: string) =>
      uri === BRIDGE_ACTOR
        ? { uri: BRIDGE_ACTOR, oxyUserId: BRIDGE_OXY_ID, type: 'Person', domain: 'bird.makeup' }
        : { uri: ACTOR_URI, oxyUserId: ALICE_OXY_ID, type: 'Person' },
    );
  });

  afterEach(async () => {
    await getDb().delete(posts).where(like(posts.federationActivityId, `${BRIDGE_ACTOR}%`));
  });

  it('drops it', async () => {
    stubBridgeOutbox([bridgeNote('rt', 'RT: @ThomasitaD BUENAVENTURA NECESITA MÉDICOS')]);

    await runBridgeSync();

    expect(await storedCount('rt')).toBe(0);
  });

  it('CONTROL: an ordinary note from the SAME bridge is imported', async () => {
    // Without this, the case above would pass just as well if the path had
    // started refusing everything from a bridge.
    stubBridgeOutbox([bridgeNote('ordinary', 'just a normal post')]);

    await runBridgeSync();

    expect(await storedCount('ordinary')).toBe(1);
  });

  it('CONTROL: the same RT body from a NON-bridge host is kept', async () => {
    // The gate is per reviewed bridge, not a ban on the characters `RT:`. A
    // human writing "RT:" on an ordinary instance must be unaffected.
    stubRemote([createNote('human-rt', { content: '<p>RT: @someone quoting a friend</p>' })]);

    await runOutboxSync();

    expect(await storedNote('human-rt')).toBeDefined();
  });
});
