import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The federated ingest routes run the converged post-ingest enrichment.
 *
 * The ActivityPub outbox backfill is the route that does NOT go through
 * `PostCreationService`: it builds raw documents and writes them with
 * `Post.collection.insertMany`, on purpose. That is why every enrichment used to
 * have to be remembered here separately — and why media metadata, and then link
 * previews, were each added to the native route and forgotten on this one. Both
 * routes now converge on `enrichIngestedPosts` (`services/postEnrichment/`), and
 * `services/postEnrichmentParity.test.ts` pins that they cannot drift again.
 *
 * These pin, per federated route:
 *   - the outbox backfill enriches the notes it just inserted, and inserts
 *     nothing un-enriched;
 *   - it de-duplicates a link shared across the page into one resolve;
 *   - it warms NOTHING for a page whose notes carry no link;
 *   - enrichment is DETACHED — a preview service that rejects never fails, and a
 *     preview service that hangs never delays, the import;
 *   - the AP inbox `Create` hands the note's FULL link to the shared route
 *     (which owns the enrichment) rather than running one of its own.
 *
 * Both routes are driven through their real entry points (`syncOutboxPostsDetailed`
 * / the inbound dispatcher) against the mock harness `outboxMentionSelfHeal.test.ts`
 * and `inboxOxyUserIdInvariant.test.ts` established, so what is asserted is the
 * call site each route actually reaches — not a helper called in isolation.
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
  default: { updateOne: vi.fn() },
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

vi.mock('../../../models/FederatedFollow', () => ({
  default: { exists: vi.fn().mockResolvedValue({ _id: 'follow_1' }) },
}));

import { outboxSyncService } from '../../../connectors/activitypub/outbox.service';
import { activityPubConnector } from '../../../connectors/activitypub/ActivityPubConnector';

const ACTOR_URI = 'https://mastodon.social/users/alice';
const OUTBOX_URL = 'https://mastodon.social/users/alice/outbox';
const ALICE_OXY_ID = 'oxy_alice';

/** The link a note carries. Full-URL anchor — the shape `htmlToPlainText` keeps. */
const ARTICLE_URL = 'https://example.com/article-one';
const SECOND_ARTICLE_URL = 'https://example.com/article-two';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
    ...init,
  });
}

/** A `Create(Note)` authored by the outbox owner whose body is `text` + markup. */
function createNote(id: string, contentHtml: string) {
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
      content: contentHtml,
      published: '2023-04-01T12:00:00Z',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
}

/** An anchor whose visible text is the truncated rendition remote servers emit. */
function linkAnchor(url: string): string {
  return `<a href="${url}">${url.replace('https://', '')}</a>`;
}

/** Stub the outbox so the whole collection (with inline items) resolves from ONE GET. */
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

/**
 * Deliver a `Create(Note)` to the inbox exactly as a remote instance would.
 * The actor is already verified by HTTP signature at this point, which is what
 * the `verifiedActorUri` argument represents.
 */
function deliverToInbox(activity: Record<string, unknown>) {
  return activityPubConnector.processInboxActivity(activity, ACTOR_URI);
}

/**
 * The URL set the batch warm was asked for. Empty when it was never called —
 * so an assertion on this can tell "warmed nothing" from "warmed the wrong
 * thing", instead of both reading as a bare `not.toHaveBeenCalled`.
 */
function warmedBatchUrls(): string[] {
  return mocks.getLinkPreviews.mock.calls.flatMap(([urls]) => urls as string[]);
}

/** The URL set the single-post warm was asked for (the `PostCreationService` lane). */
function warmedSingleUrls(): string[] {
  return mocks.getLinkPreview.mock.calls.map(([url]) => url as string);
}

/** Let the detached (un-awaited) warm settle before asserting on it. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
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
  mocks.postFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.postInsertMany.mockResolvedValue({ insertedCount: 1 });
  mocks.postExists.mockResolvedValue(null);
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.postCreatorCreate.mockResolvedValue({ _id: 'created_post_1' });
  mocks.makeServiceRequest.mockResolvedValue({ id: 'oxy_user_1' });
  mocks.getLinkPreviews.mockResolvedValue({});
  mocks.getLinkPreview.mockResolvedValue({ url: ARTICLE_URL, status: 'pending' });
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

describe('Federated ingest — outbox backfill runs post-ingest enrichment', () => {
  it('enriches the notes it just inserted', async () => {
    stubOutbox([
      createNote('withlink', `<p>Read this ${linkAnchor(ARTICLE_URL)}</p>`),
      createNote('withlink2', `<p>And this ${linkAnchor(SECOND_ARTICLE_URL)}</p>`),
    ]);

    const result = await runOutboxSync();
    await settle();

    // The posts really were inserted on the raw path this fix targets.
    expect(result.newPostCount).toBe(2);
    expect(mocks.postInsertMany).toHaveBeenCalledTimes(1);

    // Both links were handed to Oxy, in one batch call rather than per post.
    expect(mocks.getLinkPreviews).toHaveBeenCalledTimes(1);
    expect(warmedBatchUrls()).toEqual([ARTICLE_URL, SECOND_ARTICLE_URL]);
  });

  it('de-duplicates a link shared by several notes in the same page', async () => {
    stubOutbox([
      createNote('shared1', `<p>one ${linkAnchor(ARTICLE_URL)}</p>`),
      createNote('shared2', `<p>two ${linkAnchor(ARTICLE_URL)}</p>`),
    ]);

    await runOutboxSync();
    await settle();

    // Two posts, one URL — a page of notes sharing a link costs one entry.
    expect(warmedBatchUrls()).toEqual([ARTICLE_URL]);
  });

  it('warms nothing for a page whose notes carry no link', async () => {
    stubOutbox([createNote('nolink', '<p>Just some words, no link at all.</p>')]);

    const result = await runOutboxSync();
    await settle();

    expect(result.newPostCount).toBe(1);
    expect(mocks.getLinkPreviews).not.toHaveBeenCalled();
  });

  it('imports the page even when the preview service rejects', async () => {
    mocks.getLinkPreviews.mockRejectedValue(new Error('preview service down'));
    stubOutbox([createNote('withlink', `<p>Read this ${linkAnchor(ARTICLE_URL)}</p>`)]);

    const result = await runOutboxSync();
    await settle();

    expect(result.newPostCount).toBe(1);
    expect(mocks.postInsertMany).toHaveBeenCalledTimes(1);
  });

  it('does not wait for the warm before finishing the import', async () => {
    // A preview service that never answers. If the warm were awaited, the sync
    // would never resolve and this test would time out rather than fail.
    mocks.getLinkPreviews.mockReturnValue(new Promise(() => undefined));
    stubOutbox([createNote('withlink', `<p>Read this ${linkAnchor(ARTICLE_URL)}</p>`)]);

    const result = await runOutboxSync();

    expect(result.newPostCount).toBe(1);
    expect(mocks.getLinkPreviews).toHaveBeenCalledTimes(1);
  });
});

/**
 * The inbox `Create` path does NOT warm for itself — it creates through
 * `PostCreationService`, which owns the enqueue (proved directly in
 * `postCreationLinkPreviewWarm.test.ts`, where the service is real). What the
 * inbox owes that arrangement is the half these pin: the note's link must
 * survive HTML extraction into the primary variant it hands over, and the inbox
 * must not grow a competing warm of its own.
 */
describe('Federated ingest — inbox Create routes links into the warming path', () => {
  /** The primary variant text of the single post the inbox handed to the creator. */
  function createdPrimaryText(): string {
    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    const created = mocks.postCreatorCreate.mock.calls[0][0] as {
      content: { variants?: Array<{ text: string }> };
    };
    return created.content.variants?.[0]?.text ?? '';
  }

  it('hands the accepted note FULL link to the shared creation path', async () => {
    await deliverToInbox(createNote('inboxlink', `<p>Read this ${linkAnchor(ARTICLE_URL)}</p>`));
    await settle();

    // The whole URL, not the truncated text the remote anchor displayed — a body
    // carrying only the display form would warm nothing downstream.
    expect(createdPrimaryText()).toContain(ARTICLE_URL);
    // Delegated, never duplicated: the inbox itself warms neither lane.
    expect(warmedSingleUrls()).toEqual([]);
    expect(warmedBatchUrls()).toEqual([]);
  });

  it('hands over a link-free body for a note that carries no link', async () => {
    await deliverToInbox(createNote('inboxnolink', '<p>Just some words, no link at all.</p>'));
    await settle();

    expect(createdPrimaryText()).not.toContain('http');
    expect(warmedSingleUrls()).toEqual([]);
    expect(warmedBatchUrls()).toEqual([]);
  });
});
