import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Thread-linking tests for federated reply import.
 *
 * Root cause being verified: federated replies stored `federation.inReplyTo`
 * (the raw remote parent URI) but never set the local `parentPostId` / `threadId`
 * the thread machinery reads — so replies imported as orphans, the outbox path
 * DROPPED replies entirely, and ancestors were never fetched.
 *
 * Unlike `federationService.test.ts` (which uses flat per-call mocks), these
 * tests back the `Post` model with a small STATEFUL in-memory store so the
 * recursive parent-chain resolution / ancestor backfill exercises real behavior:
 * inserted/created posts become resolvable to later resolution steps, exactly as
 * they would against MongoDB.
 */

interface StoredPost {
  _id: string;
  federation?: { activityId?: string; inReplyTo?: string };
  threadId?: string | null;
  parentPostId?: string | null;
  status?: string;
  visibility?: string;
  content?: { text?: string };
}

const h = vi.hoisted(() => {
  const store: StoredPost[] = [];
  const state = { counter: 0 };

  const findByActivityId = (uri: unknown): StoredPost | undefined =>
    store.find((p) => p.federation?.activityId !== undefined && p.federation.activityId === uri);
  const findById = (id: unknown): StoredPost | undefined => store.find((p) => p._id === id);
  const nextId = (prefix: string): string => `${prefix}_${++state.counter}`;
  const reset = (): void => {
    store.length = 0;
    state.counter = 0;
  };

  // --- Post model (stateful) ---
  const postFindOne = vi.fn((query: Record<string, any>) => ({
    lean: async () => {
      if (query?.['federation.activityId'] !== undefined) {
        const found = findByActivityId(query['federation.activityId']);
        return found ? { _id: found._id } : null;
      }
      if (query?._id !== undefined) {
        const found = findById(query._id);
        if (!found) return null;
        if (query.status !== undefined && found.status !== query.status) return null;
        if (query.visibility !== undefined && found.visibility !== query.visibility) return null;
        return { _id: found._id };
      }
      return null;
    },
  }));

  const postFindById = vi.fn((id: unknown) => ({
    lean: async () => {
      const found = findById(id);
      if (!found) return null;
      return {
        _id: found._id,
        threadId: found.threadId,
        status: found.status,
        visibility: found.visibility,
        federation: { inReplyTo: found.federation?.inReplyTo },
      };
    },
  }));

  // Supports BOTH the bulk-dedup call (`.lean()` directly) and the
  // reconciliation script's paginated call (`.sort().limit().lean()`).
  const postFind = vi.fn((query: Record<string, any>) => {
    const run = async () => {
      const inClause = query?.['federation.activityId']?.$in;
      if (Array.isArray(inClause)) {
        return store
          .filter((p) => p.federation?.activityId !== undefined && inClause.includes(p.federation.activityId))
          .map((p) => ({ federation: { activityId: p.federation?.activityId } }));
      }
      // Reconciliation orphan query: federation.inReplyTo set, parentPostId null.
      const wantsOrphans = query?.['federation.inReplyTo'] !== undefined;
      if (wantsOrphans) {
        const gt = query?._id?.$gt as string | undefined;
        return store
          .filter(
            (p) =>
              p.federation?.inReplyTo != null &&
              (p.parentPostId === null || p.parentPostId === undefined) &&
              (gt === undefined || p._id > gt),
          )
          .sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
          .map((p) => ({ _id: p._id, federation: { inReplyTo: p.federation?.inReplyTo } }));
      }
      return [];
    };
    const chain = {
      sort: () => chain,
      limit: () => chain,
      lean: run,
    };
    return chain;
  });

  const postUpdateOne = vi.fn(async (query: Record<string, any>, update: Record<string, any>) => {
    let target: StoredPost | undefined;
    if (query?.['federation.activityId'] !== undefined) target = findByActivityId(query['federation.activityId']);
    else if (query?._id !== undefined) target = findById(query._id);
    if (target && update?.$set) {
      if (update.$set.parentPostId !== undefined) target.parentPostId = update.$set.parentPostId;
      if (update.$set.threadId !== undefined) target.threadId = update.$set.threadId;
    }
    return { modifiedCount: target ? 1 : 0 };
  });

  const postExists = vi.fn(async (query: Record<string, any>) => {
    const found = findByActivityId(query?.['federation.activityId']);
    return found ? { _id: found._id } : null;
  });

  const postInsertMany = vi.fn(async (docs: Record<string, any>[]) => {
    for (const doc of docs) {
      store.push({
        _id: nextId('inserted'),
        federation: {
          activityId: (doc.federation as { activityId?: string })?.activityId,
          inReplyTo: (doc.federation as { inReplyTo?: string })?.inReplyTo,
        },
        threadId: (doc.threadId as string | null | undefined) ?? null,
        parentPostId: (doc.parentPostId as string | null | undefined) ?? null,
        status: doc.status as string | undefined,
        visibility: doc.visibility as string | undefined,
        content: doc.content as { text?: string } | undefined,
      });
    }
    return { insertedCount: docs.length };
  });

  const postCountDocuments = vi.fn(async (query: Record<string, any>) => {
    if (query?.['federation.inReplyTo'] !== undefined) {
      return store.filter(
        (p) => p.federation?.inReplyTo != null && (p.parentPostId === null || p.parentPostId === undefined),
      ).length;
    }
    return store.length;
  });

  const postBulkWrite = vi.fn(async (ops: Array<{ updateOne?: { filter: Record<string, any>; update: Record<string, any> } }>) => {
    let modified = 0;
    for (const op of ops) {
      const u = op.updateOne;
      if (!u) continue;
      const target = u.filter._id !== undefined ? findById(u.filter._id) : undefined;
      if (target && u.update?.$set) {
        if (u.update.$set.parentPostId !== undefined) target.parentPostId = u.update.$set.parentPostId;
        if (u.update.$set.threadId !== undefined) target.threadId = u.update.$set.threadId;
        modified += 1;
      }
    }
    return { modifiedCount: modified };
  });

  // --- post creator (PostCreationService stand-in) ---
  const postCreatorCreate = vi.fn(async (params: Record<string, any>) => {
    const created: StoredPost = {
      _id: nextId('created'),
      federation: {
        activityId: (params.federation as { activityId?: string })?.activityId,
        inReplyTo: (params.federation as { inReplyTo?: string })?.inReplyTo,
      },
      threadId: (params.threadId as string | null | undefined) ?? null,
      parentPostId: (params.parentPostId as string | null | undefined) ?? null,
      status: 'published',
      visibility: (params.visibility as string | undefined) ?? 'public',
      content: params.content as { text?: string } | undefined,
    };
    store.push(created);
    return created;
  });

  // --- other dependency mocks ---
  const getPublicKey = vi.fn();
  const signRequest = vi.fn();
  const signViaOxy = vi.fn();
  const actorFindOne = vi.fn();
  const actorFind = vi.fn();
  const actorFindOneAndUpdate = vi.fn();
  const actorUpdateOne = vi.fn();
  const followExists = vi.fn();
  const assertSafePublicUrl = vi.fn();
  const fetchUpstreamSingleHop = vi.fn();
  const fetchUpstreamFollowingRedirects = vi.fn();
  const persistRemoteMedia = vi.fn();
  const recordAccess = vi.fn();
  const userSettingsUpdateOne = vi.fn();
  const likeCreate = vi.fn();
  const likeFindOneAndDelete = vi.fn();
  const getServiceOxyClient = vi.fn();

  return {
    store,
    findByActivityId,
    findById,
    nextId,
    reset,
    postFindOne,
    postFindById,
    postFind,
    postUpdateOne,
    postExists,
    postInsertMany,
    postCountDocuments,
    postBulkWrite,
    postCreatorCreate,
    getPublicKey,
    signRequest,
    signViaOxy,
    actorFindOne,
    actorFind,
    actorFindOneAndUpdate,
    actorUpdateOne,
    followExists,
    assertSafePublicUrl,
    fetchUpstreamSingleHop,
    fetchUpstreamFollowingRedirects,
    persistRemoteMedia,
    recordAccess,
    userSettingsUpdateOne,
    likeCreate,
    likeFindOneAndDelete,
    getServiceOxyClient,
  };
});

vi.mock('../../connectors/activitypub/crypto', () => ({
  getPublicKey: h.getPublicKey,
  signViaOxy: h.signViaOxy,
  signRequest: h.signRequest,
}));

vi.mock('../../models/FederatedActor', () => ({
  default: {
    findOne: h.actorFindOne,
    find: h.actorFind,
    findOneAndUpdate: h.actorFindOneAndUpdate,
    updateOne: h.actorUpdateOne,
  },
}));

vi.mock('../../models/FederatedFollow', () => ({
  default: { exists: h.followExists },
}));

vi.mock('../../utils/ssrfGuard', () => ({
  assertSafePublicUrl: h.assertSafePublicUrl,
}));

vi.mock('../../models/FederationDeliveryQueue', () => ({
  default: {},
  getNextRetryTime: vi.fn(),
}));

vi.mock('../../models/Post', () => ({
  POST_CLASSIFICATION_PENDING: 'pending',
  Post: {
    find: h.postFind,
    findOne: h.postFindOne,
    findById: h.postFindById,
    updateOne: h.postUpdateOne,
    exists: h.postExists,
    countDocuments: h.postCountDocuments,
    bulkWrite: h.postBulkWrite,
    collection: { insertMany: h.postInsertMany },
  },
}));

vi.mock('../../models/Like', () => ({
  default: { create: h.likeCreate, findOneAndDelete: h.likeFindOneAndDelete },
}));

vi.mock('../../models/UserSettings', () => ({
  default: { updateOne: h.userSettingsUpdateOne },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: h.getServiceOxyClient,
}));

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

vi.mock('../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: h.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

import { activityPubConnector as federationService } from '../../connectors/activitypub/ActivityPubConnector';
import { outboxSyncService } from '../../connectors/activitypub/outbox.service';
import backfillFederatedThreadLinks from '../../scripts/backfillFederatedThreadLinks';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
    ...init,
  });
}

const ACTOR_URI = 'https://mastodon.social/users/alice';

/** A Create activity wrapping a Note (optionally a reply). */
function replyCreateActivity(id: string, inReplyTo?: string) {
  const note: Record<string, unknown> = {
    id: `${ACTOR_URI}/statuses/${id}`,
    type: 'Note',
    attributedTo: ACTOR_URI,
    content: `<p>post ${id}</p>`,
    published: '2026-06-18T12:00:00Z',
    to: ['https://www.w3.org/ns/activitystreams#Public'],
  };
  if (inReplyTo) note.inReplyTo = inReplyTo;
  return {
    id: `${ACTOR_URI}/statuses/${id}/activity`,
    type: 'Create',
    actor: ACTOR_URI,
    published: '2026-06-18T12:00:00Z',
    object: note,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();

  h.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/instance#main-key',
    publicKeyPem: 'public',
  });
  h.signViaOxy.mockResolvedValue('signature');
  h.signRequest.mockResolvedValue({ Signature: 'signature' });

  // Default: the outbox owner is a known, fresh federated actor.
  h.actorFindOne.mockReturnValue({
    lean: vi.fn().mockResolvedValue({
      uri: ACTOR_URI,
      oxyUserId: 'oxy_alice',
      lastFetchedAt: new Date(),
    }),
  });
  h.actorFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  h.actorFindOneAndUpdate.mockResolvedValue({ _id: 'actor_1' });
  h.actorUpdateOne.mockResolvedValue({ modifiedCount: 1 });

  h.followExists.mockResolvedValue({ _id: 'follow_1' });
  h.assertSafePublicUrl.mockResolvedValue({ ok: true, ip: '93.184.216.34', family: 4 });
  h.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  h.recordAccess.mockResolvedValue(undefined);
  h.userSettingsUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  h.likeCreate.mockResolvedValue({ _id: 'like_1' });
  h.likeFindOneAndDelete.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  h.getServiceOxyClient.mockReturnValue({ makeServiceRequest: vi.fn() });

  // signedFetch is built on fetchUpstreamSingleHop; adapt it to the per-test
  // stubbed global fetch (same bridge as federationService.test.ts).
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

describe('inbox handleCreate — reply linking', () => {
  it('links parentPostId + threadId when the parent is already local', async () => {
    // Pre-existing local (imported federated) parent, a thread root (threadId unset).
    const parentUri = `${ACTOR_URI}/statuses/100`;
    h.store.push({
      _id: 'parent_local',
      federation: { activityId: parentUri },
      threadId: null,
      parentPostId: null,
      status: 'published',
      visibility: 'public',
    });

    await federationService.processInboxActivity(
      replyCreateActivity('101', parentUri),
      ACTOR_URI,
    );

    expect(h.postCreatorCreate).toHaveBeenCalledTimes(1);
    const params = h.postCreatorCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(params.parentPostId).toBe('parent_local');
    // threadId = parent.threadId ?? parent._id → root id (native rule).
    expect(params.threadId).toBe('parent_local');
    expect((params.federation as { inReplyTo?: string }).inReplyTo).toBe(parentUri);
  });

  it('stores a non-reply post with null parentPostId/threadId', async () => {
    await federationService.processInboxActivity(replyCreateActivity('200'), ACTOR_URI);

    const params = h.postCreatorCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(params.parentPostId).toBeNull();
    expect(params.threadId).toBeNull();
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
      { uri: ACTOR_URI, acct: 'alice@mastodon.social', outboxUrl, oxyUserId: 'oxy_alice' },
      { limit: 10, maxPages: 1 },
    );

    // All four notes imported (replies are no longer dropped).
    expect(result.newPostCount).toBe(4);

    const byActivity = (n: string) => h.findByActivityId(`${ACTOR_URI}/statuses/${n}`);
    const root = byActivity('1');
    const r2 = byActivity('2');
    const r3 = byActivity('3');
    const r4 = byActivity('4');
    expect(root && r2 && r3 && r4).toBeTruthy();

    // Root: no parent, no threadId (native top-level post semantics).
    expect(root?.parentPostId ?? null).toBeNull();
    expect(root?.threadId ?? null).toBeNull();

    // Each reply points at its immediate parent...
    expect(r2?.parentPostId).toBe(root?._id);
    expect(r3?.parentPostId).toBe(r2?._id);
    expect(r4?.parentPostId).toBe(r3?._id);

    // ...and EVERY reply shares the SAME thread root id, regardless of the
    // newest-first import order.
    expect(r2?.threadId).toBe(root?._id);
    expect(r3?.threadId).toBe(root?._id);
    expect(r4?.threadId).toBe(root?._id);
  });
});

describe('outbox backfill — bounded ancestor backfill', () => {
  const outboxUrl = `${ACTOR_URI}/outbox`;
  const firstPageUrl = `${ACTOR_URI}/outbox?page=true`;

  it('fetches + imports a NON-local parent and links the reply to it', async () => {
    const parentUri = `${ACTOR_URI}/statuses/500`;
    const replyActivity = replyCreateActivity('501', parentUri);

    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 1, first: firstPageUrl });
      }
      if (url === firstPageUrl) {
        return jsonResponse({ type: 'OrderedCollectionPage', id: firstPageUrl, orderedItems: [replyActivity] });
      }
      // The parent Note is NOT in the outbox/store — it is fetched on demand.
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
      { uri: ACTOR_URI, acct: 'alice@mastodon.social', outboxUrl, oxyUserId: 'oxy_alice' },
      { limit: 10, maxPages: 1 },
    );

    // Parent was fetched on demand and imported via the post creator.
    expect(fetchMock).toHaveBeenCalledWith(parentUri, expect.anything());
    const parent = h.findByActivityId(parentUri);
    expect(parent).toBeTruthy();

    // The reply is linked to the backfilled parent, which is the thread root.
    const reply = h.findByActivityId(`${ACTOR_URI}/statuses/501`);
    expect(reply?.parentPostId).toBe(parent?._id);
    expect(reply?.threadId).toBe(parent?._id);
  });

  it('respects the depth cap on an infinite ancestor chain (no runaway, reply still linked)', async () => {
    // Every fetched status N is a reply to status N+1 — an unbounded ascending
    // chain. The depth cap must terminate the backfill.
    const fetchMock = vi.fn(async (url: string) => {
      const match = url.match(/\/statuses\/(\d+)$/);
      if (match) {
        const n = Number(match[1]);
        return jsonResponse({
          id: url,
          type: 'Note',
          attributedTo: ACTOR_URI,
          content: `<p>ancestor ${n}</p>`,
          inReplyTo: `${ACTOR_URI}/statuses/${n + 1}`,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    // Inbox reply whose parent starts the infinite chain.
    await federationService.processInboxActivity(
      replyCreateActivity('1000', `${ACTOR_URI}/statuses/1001`),
      ACTOR_URI,
    );

    // Terminated (test did not hang) and bounded: the on-demand parent fetches
    // never exceed the depth cap (30) by more than a small constant.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(32);

    // The original reply is still created (best-effort) and linked to its
    // immediate parent.
    expect(h.postCreatorCreate).toHaveBeenCalled();
    const reply = h.postCreatorCreate.mock.calls.find(
      (c) => (c[0].federation as { activityId?: string })?.activityId === `${ACTOR_URI}/statuses/1000`,
    );
    expect(reply).toBeTruthy();
    const replyParams = reply?.[0] as Record<string, unknown>;
    expect(replyParams.parentPostId).toBe(h.findByActivityId(`${ACTOR_URI}/statuses/1001`)?._id);
  });
});

describe('reconciliation script — backfillFederatedThreadLinks', () => {
  it('links an already-imported orphan (inReplyTo set, parentPostId null)', async () => {
    const parentUri = `${ACTOR_URI}/statuses/700`;
    // Local parent (thread root) + an orphaned reply pointing at it.
    h.store.push({
      _id: 'aaa_parent',
      federation: { activityId: parentUri },
      threadId: null,
      parentPostId: null,
      status: 'published',
      visibility: 'public',
    });
    h.store.push({
      _id: 'bbb_orphan',
      federation: { activityId: `${ACTOR_URI}/statuses/701`, inReplyTo: parentUri },
      threadId: null,
      parentPostId: null,
      status: 'published',
      visibility: 'public',
    });
    // A non-orphan (already linked) — must be left untouched / not matched.
    h.store.push({
      _id: 'ccc_linked',
      federation: { activityId: `${ACTOR_URI}/statuses/702`, inReplyTo: parentUri },
      threadId: 'aaa_parent',
      parentPostId: 'aaa_parent',
      status: 'published',
      visibility: 'public',
    });

    await backfillFederatedThreadLinks();

    const orphan = h.findById('bbb_orphan');
    expect(orphan?.parentPostId).toBe('aaa_parent');
    expect(orphan?.threadId).toBe('aaa_parent');

    // Unrelated already-linked reply is unchanged.
    const linked = h.findById('ccc_linked');
    expect(linked?.parentPostId).toBe('aaa_parent');
  });
});
