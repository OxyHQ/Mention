/**
 * The three hand-built controller feeds that page over `posts`, and what each
 * one does with a Meta cross-post.
 *
 * `#990` splits them two ways, and the split is the subject of this file:
 *
 *   quotes   COLLAPSE — "who quoted this" is a feed of cards, and a quoter who
 *                       cross-posted their quote to Instagram and to Threads
 *                       wrote one quote. The MTN `quotes` source already read it
 *                       that way; this handler did not.
 *   nearby   COLLAPSE — the map is a discovery surface choosing what to show,
 *                       and `relatedSources.nearby` already agreed.
 *   replies  KEEP BOTH — a reply to the Instagram post is the INSTAGRAM post's
 *                       reply. `#990` is explicit that source-specific reply
 *                       trees stay source-specific, so collapsing here would
 *                       move somebody's reply onto a thread they never replied
 *                       to.
 *
 * The replies case is the one worth having: it is the only place in the codebase
 * where omitting the term is correct AND the surrounding code pages over posts
 * exactly like the two that must carry it. Without a test saying so, the next
 * person sweeping for missing call sites adds it and silently re-parents
 * replies.
 *
 * Hydration is a passthrough stub for the same reason as
 * `getRepliesFeedSpine.test.ts`: it resolves authors through Oxy, and every
 * selection asserted here happens before it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: {
    hydratePosts: vi.fn(async (records: Array<{ id: string; oxyUserId: string }>) =>
      records.map((record) => ({ ...record, user: { id: record.oxyUserId } })),
    ),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

const privacyMocks = vi.hoisted(() => ({
  loadPrivacyState: vi.fn(async () => ({ excludedUserIds: new Set() })),
}));
vi.mock('../../mtn/UserPrivacyManager', () => ({
  UserPrivacyManager: { loadPrivacyState: privacyMocks.loadPrivacyState },
}));

const oxyMocks = vi.hoisted(() => ({
  scopedClient: {},
  createScopedOxyClient: vi.fn(),
}));
oxyMocks.createScopedOxyClient.mockReturnValue(oxyMocks.scopedClient);
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: oxyMocks.createScopedOxyClient,
  createUserScopedOxyServices: vi.fn(),
  getServiceOxyClient: () => undefined,
}));

import { inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { createCluster } from '../../db/posts/postEquivalenceRepository';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { feedController } from '../../controllers/feed.controller';
import { getNearbyPosts } from '../../controllers/posts/geo';

const scope = postScope('crosspost-controller-feeds');
const AUTHOR = scope.user('author');

/** A point no other suite's fixtures sit on, so a radius read finds only these. */
const LAT = -54.8019;
const LNG = -68.3029;

interface Payload {
  items?: Array<{ id: string }>;
  posts?: Array<{ id: string }>;
  status?: number;
}

function buildResponse(): { res: unknown; payload: { value?: Payload; status?: number } } {
  const payload: { value?: Payload; status?: number } = {};
  const res = {
    status(code: number) {
      payload.status = code;
      return this;
    },
    json(body: unknown) {
      payload.value = body as Payload;
      return this;
    },
  };
  return { res, payload };
}

/**
 * Two variants of one cross-post, clustered through the shipped writer, with
 * `apply` deciding what each variant IS — a quote, a reply, or a located post.
 */
async function crosspostPair(
  apply: (label: 'instagram' | 'threads') => Parameters<typeof seedPost>[1],
): Promise<{ shown: string; hidden: string }> {
  const shown = (await seedPost(scope, { oxyUserId: AUTHOR, ...apply('instagram') })).id;
  const hidden = (await seedPost(scope, { oxyUserId: AUTHOR, ...apply('threads') })).id;
  await createCluster('declared', [
    { postId: shown, networkDomain: 'instagram.com', preferred: true, evidence: 'declared original' },
    { postId: hidden, networkDomain: 'threads.net', preferred: false, evidence: 'declared crosspost' },
  ]);
  return { shown, hidden };
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearPostScope(scope);
  vi.clearAllMocks();
});

afterAll(async () => {
  await closePostgres();
});

describe('the quotes feed', () => {
  it('shows a cross-posted quote once, and keeps both source posts stored', async () => {
    const anchor = await seedPost(scope, { oxyUserId: scope.user('quoted') });
    const { shown, hidden } = await crosspostPair(() => ({ quoteOf: anchor.id }));

    const { res, payload } = buildResponse();
    await feedController.getQuotesFeed(
      { query: {}, params: { postId: anchor.id }, user: { id: scope.user('viewer') }, headers: {} } as never,
      res as never,
    );

    expect(payload.value?.items?.map((item) => item.id)).toEqual([shown]);
    const stored = await getDb().select({ id: posts.id }).from(posts).where(inArray(posts.id, [shown, hidden]));
    expect([...stored]).toHaveLength(2);
  });
});

describe('the nearby-posts map', () => {
  it('drops one pin for a cross-post, not two', async () => {
    const { shown, hidden } = await crosspostPair(() => ({}));
    // The `geography` column the radius read uses is GENERATED from the pair of
    // coordinate columns, so the fixture sets those and the index does the rest.
    await getDb()
      .update(posts)
      .set({ contentLocationLatitude: LAT, contentLocationLongitude: LNG })
      .where(inArray(posts.id, [shown, hidden]));

    const { res, payload } = buildResponse();
    await getNearbyPosts(
      { query: { lat: String(LAT), lng: String(LNG), radius: '500' }, user: { id: scope.user('viewer') }, headers: {} } as never,
      res as never,
    );

    expect(payload.value?.posts?.map((post) => post.id)).toEqual([shown]);
  });
});

describe('the replies feed', () => {
  /**
   * The deliberate NON-collapse. Both source replies stay, because each one
   * answers its own source post and #990 keeps reply trees source-specific.
   */
  it('keeps both source replies to the same parent', async () => {
    const parent = await seedPost(scope, { oxyUserId: scope.user('parent-author') });
    const { shown, hidden } = await crosspostPair(() => ({
      parentPostId: parent.id,
      isReply: true,
    }));

    const { res, payload } = buildResponse();
    await feedController.getRepliesFeed(
      { query: { sort: 'oldest' }, params: { parentId: parent.id }, user: { id: scope.user('viewer') }, headers: {} } as never,
      res as never,
    );

    expect(payload.value?.items?.map((item) => item.id).sort()).toEqual([shown, hidden].sort());
  });
});
