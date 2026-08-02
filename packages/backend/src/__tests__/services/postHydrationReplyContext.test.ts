import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * Reply context is a property of the POST, so it must survive a plain
 * `hydratePosts` call — no slices involved.
 *
 * That is the whole point of the field. The only carrier used to be
 * `FeedSliceReason.replyContext`, which exists solely for feeds whose definition
 * opts into reply slicing (`execution.replyContext`, true for 5 of ~15) and never
 * at all on the response paths that return posts in a flat `items[]` with
 * `slices: []` — the anonymous For You / videos / media popular fallback, ordered
 * feeds (saved, likes), and feed generators. Nor on search, saved, insights or the
 * thread view, which call the renderer with a bare post. Every one of those
 * surfaces rendered a reply as an ordinary top-level post; measured against
 * production, `descriptor=trending` returned 25 slices of which 14 held a reply
 * and NONE carried a reply reason.
 *
 * These tests therefore all go through `hydratePosts`, the flat path.
 */

/**
 * Scoped, because vitest runs files in parallel against one database: a
 * hardcoded id is a claim about every other file in the run, and the PARENT here
 * is a real row the lookup has to find.
 */
const scope = serviceScope('hydration-reply-context');
const PARENT_AUTHOR_ID = scope.user('parent-author');
const REPLY_AUTHOR_ID = scope.user('reply-author');
const VIEWER_ID = scope.user('viewer');

/** Ids only the page carries — never fetched, so they need no row. */
const REPLY_ID = `${scope.name}-reply`;
const ROOT_ID = `${scope.name}-root`;
const FEDERATED_REPLY_ID = `${scope.name}-federated-reply`;

/** Seeded parent ids. Assigned in `beforeAll`, before any test builds a row. */
let PARENT_ID = '';
/** A parent by the REPLY author — the self-thread case, fetched not paged. */
let SELF_PARENT_ID = '';
/** A federated parent by the reply author, for the linked-self-thread case. */
let FEDERATED_SELF_PARENT_ID = '';

const { getUsersByIds, loadPostRecordsSpy } = vi.hoisted(() => ({
  getUsersByIds: vi.fn(),
  loadPostRecordsSpy: vi.fn(),
}));

vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserFollowing: vi.fn(async () => ({ following: [] })),
    getUserFollowers: vi.fn(async () => ({ followers: [] })),
    getUserById: vi.fn(),
  }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds,
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => `https://cdn.test/${id}`,
  }),
}));

vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: (res: unknown) =>
    Array.isArray((res as { following?: unknown[] })?.following)
      ? (res as { following: string[] }).following
      : [],
  extractFollowersIds: (res: unknown) =>
    Array.isArray((res as { followers?: unknown[] })?.followers)
      ? (res as { followers: string[] }).followers
      : [],
}));

/**
 * The parent LOOKUP is the real repository call, wrapped in a spy.
 *
 * Two of the cases below assert that no lookup happens at all — the cost guard
 * for pages of roots and for a parent already in hand — and that needs an
 * observable on the query itself, not on its result. Wrapping rather than
 * replacing keeps the query real: a stub would answer from the test's own map
 * and could not tell a working fetch from one that silently matches nothing.
 */
vi.mock('../../db/posts/postRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/posts/postRepository')>();
  return {
    ...actual,
    loadPostRecords: (ids: string[], ...rest: unknown[]) => {
      loadPostRecordsSpy(ids);
      return (actual.loadPostRecords as (...a: unknown[]) => unknown)(ids, ...rest);
    },
  };
});

const cacheStore = new Map<string, CachedUserSummary>();
vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async (ids: string[]) => {
    const hits = new Map<string, CachedUserSummary>();
    for (const id of ids) {
      const hit = cacheStore.get(id);
      if (hit) hits.set(id, hit);
    }
    return hits;
  }),
  mset: vi.fn(async (entries: Map<string, CachedUserSummary>) => {
    for (const [id, value] of entries) cacheStore.set(id, value);
  }),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { PostHydrationService } from '../../services/PostHydrationService';

function makePostRow(id: string, authorId: string, extra: Record<string, unknown> = {}) {
  return {
    _id: id,
    oxyUserId: authorId,
    authorship: [{ oxyUserId: authorId, role: 'owner', status: 'accepted' }],
    type: 'post',
    content: { text: `body of ${id}` },
    stats: { likesCount: 0, boostsCount: 0, commentsCount: 0, downvotesCount: 0, viewsCount: 0 },
    metadata: { createdAt: new Date('2024-01-01T00:00:00Z') },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    visibility: 'public',
    status: 'published',
    hashtags: [],
    mentions: [],
    // The STORED discriminator both reply-context carriers read. `extra` may
    // override it — a fixture that sets `parentPostId` or a federated
    // `inReplyTo` is a reply, and stating it here is what the row would carry
    // after `derivesReplyIntent` ran at insert.
    isReply: Boolean(
      (extra as { parentPostId?: unknown }).parentPostId
      || (extra as { federation?: { inReplyTo?: string } }).federation?.inReplyTo,
    ),
    ...extra,
  };
}

/** The ids each parent lookup asked for, in order. */
function parentLookupIds(): string[][] {
  return loadPostRecordsSpy.mock.calls.map(([ids]) => ids as string[]);
}

describe('PostHydrationService — reply context on the flat (slice-free) path', () => {
  let service: PostHydrationService;

  beforeAll(async () => {
    await connectPostgres();
    // The parent lives ONLY in the database — it is never part of the hydrated
    // page, which is the whole point of the lookup these cases measure.
    const parent = await seedPost(scope, {
      oxyUserId: PARENT_AUTHOR_ID,
      content: { variants: [{ source: 'author', text: 'the parent', tag: 'en' }] },
    });
    PARENT_ID = parent.id;

    SELF_PARENT_ID = (await seedPost(scope, {
      oxyUserId: REPLY_AUTHOR_ID,
      content: { variants: [{ source: 'author', text: 'my own earlier post', tag: 'en' }] },
    })).id;

    FEDERATED_SELF_PARENT_ID = (await seedPost(scope, {
      oxyUserId: REPLY_AUTHOR_ID,
      content: { variants: [{ source: 'author', text: 'my own earlier note', tag: 'en' }] },
      federation: { activityId: 'https://remote.example/users/self/statuses/1' },
    })).id;
  });

  afterAll(async () => {
    await clearServiceScope(scope);
    await closePostgres();
  });

  beforeEach(() => {
    cacheStore.clear();
    getUsersByIds.mockReset();
    getUsersByIds.mockResolvedValue([
      { id: PARENT_AUTHOR_ID, username: 'parenthandle', name: { displayName: 'Parent Author' }, badges: [], verified: false },
      { id: REPLY_AUTHOR_ID, username: 'replyhandle', name: { displayName: 'Reply Author' }, badges: [], verified: false },
    ]);
    loadPostRecordsSpy.mockReset();
    service = new PostHydrationService();
  });

  it('names the parent author on a reply whose parent is not on the page', async () => {
    const reply = makePostRow(REPLY_ID, REPLY_AUTHOR_ID, { parentPostId: PARENT_ID });

    const [hydrated] = await service.hydratePosts([reply], { viewerId: VIEWER_ID });

    expect(hydrated.replyContext).toBeDefined();
    expect(hydrated.replyContext?.parentAuthor?.id).toBe(PARENT_AUTHOR_ID);
    // The canonical Oxy identity, resolved through the same batch every other
    // author on the page goes through — never a hand-built name.
    expect(hydrated.replyContext?.parentAuthor?.username).toBe('parenthandle');
    expect(hydrated.replyContext?.parentAuthor?.name.displayName).toBe('Parent Author');

    // Vacuity floor for the two "no lookup" tests below: this is what a real
    // parent lookup looks like, so those assertions are measuring something.
    expect(parentLookupIds()).toEqual([[PARENT_ID]]);
  });

  it('marks a reply whose parent link never resolved, naming nobody', async () => {
    // A federated reply the outbox connector could not link: `federation.inReplyTo`
    // survives, `parentPostId` is null. `isReplyPost` is what still counts it as a
    // reply — reading `parentPostId` alone classified these as thread roots.
    const federatedReply = makePostRow(FEDERATED_REPLY_ID, REPLY_AUTHOR_ID, {
      parentPostId: null,
      federation: {
        activityId: 'https://remote.example/users/someone/statuses/2',
        inReplyTo: 'https://remote.example/users/someone/statuses/1',
      },
    });

    const [hydrated] = await service.hydratePosts([federatedReply], { viewerId: VIEWER_ID });

    // Present, so the row still declares itself a reply…
    expect(hydrated.replyContext).toBeDefined();
    // …but empty, because there is genuinely nobody to name.
    expect(hydrated.replyContext?.parentAuthor).toBeUndefined();
  });

  it('marks a reply whose parent link never resolved with an EXPLICIT empty context', async () => {
    // Spelled out separately from the assertion above because this is the shape
    // most likely to regress silently: if `replyContext` came back `undefined`
    // here the post would pass as a thread ROOT and render as an ordinary
    // top-level post — the original bug, in the one case that cannot be spotted
    // by looking at `parentPostId`.
    const federatedReply = makePostRow('650000000000000000000038', REPLY_AUTHOR_ID, {
      parentPostId: null,
      federation: {
        activityId: 'https://remote.example/users/someone/statuses/9',
        inReplyTo: 'https://remote.example/users/someone/statuses/8',
      },
    });

    const [hydrated] = await service.hydratePosts([federatedReply], { viewerId: VIEWER_ID });

    expect(hydrated.replyContext).toEqual({});
    expect(hydrated.replyContext).not.toBeUndefined();
  });

  it('omits reply context entirely for a self-thread continuation', async () => {
    // Replying to one's OWN post is a thread, not reply context. Emitting it
    // would put "Replying to @themselves" on every post of every self-thread.
    const continuation = makePostRow(REPLY_ID, REPLY_AUTHOR_ID, { parentPostId: SELF_PARENT_ID });

    const [hydrated] = await service.hydratePosts([continuation], { viewerId: VIEWER_ID });

    expect(hydrated.replyContext).toBeUndefined();
  });

  it('keeps reply context when the SAME page holds both a self-thread and a real reply', async () => {
    // The suppression is per-post, not per-page: one self-continuation must not
    // silence a genuine reply hydrated alongside it.
    const ownParentId = `${scope.name}-own-parent`;
    const continuationId = `${scope.name}-continuation`;
    const realReplyId = `${scope.name}-real-reply`;
    // The self-parent is ON the page, so it needs no row; the real reply's
    // parent is the seeded one, which is fetched.
    const ownParent = makePostRow(ownParentId, REPLY_AUTHOR_ID);
    const continuation = makePostRow(continuationId, REPLY_AUTHOR_ID, {
      parentPostId: ownParentId,
    });
    const realReply = makePostRow(realReplyId, REPLY_AUTHOR_ID, { parentPostId: PARENT_ID });

    const hydrated = await service.hydratePosts(
      [ownParent, continuation, realReply],
      { viewerId: VIEWER_ID },
    );

    const byId = new Map(hydrated.map((post) => [post.id, post]));
    expect(byId.get(continuationId)?.replyContext).toBeUndefined();
    expect(byId.get(realReplyId)?.replyContext?.parentAuthor?.username).toBe('parenthandle');
  });

  it('cannot detect a self-thread when the federated parent was never linked', async () => {
    // KNOWN LIMIT, asserted so it is visible rather than a surprise.
    //
    // The self-thread suppression compares two authoritative `oxyUserId`s. An
    // unlinked federated reply has no local parent at all, so there is no second
    // id to compare and the post renders the generic "Replying to a post" rather
    // than nothing. It can never render "Replying to @themselves" — it names
    // nobody — so the failure mode is a redundant row, not a wrong one.
    //
    // Deliberately NOT closed by sniffing `federation.inReplyTo` for the author's
    // own actor URI: that shape is Mastodon-specific (Pleroma `/objects/<uuid>`,
    // Lemmy `/comment/<id>`, PeerTube `/videos/watch/<uuid>` do not follow it),
    // and a false positive would suppress a GENUINE reply to someone else —
    // strictly worse than the redundant row it would remove.
    //
    // Narrow in practice: a federated self-thread's parent is by the same remote
    // actor, so the outbox import that brought in the continuation normally
    // brought in its root too (`resolveThreadLink` walks and backfills). The
    // unlinked case is far more common for CROSS-author replies, where the parent
    // lives on an instance we never fetched — and those SHOULD show the row.
    const unlinkedSelfContinuation = makePostRow(`${scope.name}-unlinked-self`, REPLY_AUTHOR_ID, {
      parentPostId: null,
      federation: {
        activityId: 'https://remote.example/users/self/statuses/2',
        inReplyTo: 'https://remote.example/users/self/statuses/1',
      },
    });

    const [hydrated] = await service.hydratePosts([unlinkedSelfContinuation], { viewerId: VIEWER_ID });

    expect(hydrated.replyContext).toEqual({});
    expect(hydrated.replyContext?.parentAuthor).toBeUndefined();
  });

  it('DOES suppress a federated self-thread once its parent is linked', async () => {
    // The counterpart to the limit above: the moment `parentPostId` resolves,
    // the comparison has both ids and federated self-threads behave exactly like
    // native ones. This is the common case.
    const continuation = makePostRow(`${scope.name}-fed-continuation`, REPLY_AUTHOR_ID, {
      parentPostId: FEDERATED_SELF_PARENT_ID,
      federation: {
        activityId: 'https://remote.example/users/self/statuses/2',
        inReplyTo: 'https://remote.example/users/self/statuses/1',
      },
    });

    const [hydrated] = await service.hydratePosts([continuation], { viewerId: VIEWER_ID });

    expect(hydrated.replyContext).toBeUndefined();
  });

  it('leaves a thread root with no reply context at all', async () => {
    const root = makePostRow(ROOT_ID, REPLY_AUTHOR_ID, { parentPostId: null, threadId: 'thread-1' });

    const [hydrated] = await service.hydratePosts([root], { viewerId: VIEWER_ID });

    expect(hydrated.replyContext).toBeUndefined();
  });

  it('issues no parent lookup for a page that holds no replies', async () => {
    // The cost guard. Discovery lanes are mostly roots, and they must not pay an
    // extra round trip to learn that nothing on the page is a reply.
    const root = makePostRow(ROOT_ID, REPLY_AUTHOR_ID, { parentPostId: null });

    await service.hydratePosts([root], { viewerId: VIEWER_ID });

    expect(parentLookupIds()).toEqual([]);
  });

  it('reuses a parent already on the page instead of re-querying it', async () => {
    const parent = makePostRow(PARENT_ID, PARENT_AUTHOR_ID);
    const reply = makePostRow(REPLY_ID, REPLY_AUTHOR_ID, { parentPostId: PARENT_ID });

    const hydrated = await service.hydratePosts([parent, reply], { viewerId: VIEWER_ID });

    const hydratedReply = hydrated.find((post) => post.id === REPLY_ID);
    expect(hydratedReply?.replyContext?.parentAuthor?.username).toBe('parenthandle');
    // Already in hand — a second fetch would be pure waste on every threaded page.
    expect(parentLookupIds()).toEqual([]);
  });
});
