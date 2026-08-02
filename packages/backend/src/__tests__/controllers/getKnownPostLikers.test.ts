import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for {@link getKnownPostLikers} — the post-detail social-proof
 * endpoint (`GET /posts/:id/likes/known`).
 *
 * Three properties matter and are asserted independently:
 *
 *  1. **Anonymous viewers get 200 + empty**, never 401. The row is decorative on
 *     a PUBLIC screen, so an auth failure here would log an error per detail
 *     view for every signed-out reader.
 *  2. **A viewer who follows nobody never queries likes at all.** An empty `$in`
 *     would match nothing anyway; short-circuiting keeps a pointless query off
 *     the hottest read.
 *  3. **The candidate set stays bounded.** Measured against a 150k-like post,
 *     the indexable shape costs 5000 keys / 0 docs examined; letting the
 *     candidate list grow unbounded keeps the endpoint CORRECT and quietly
 *     makes it O(likes).
 *
 * ## KNOWN DEFECT — this endpoint reads a store nothing writes any more
 *
 * `PostEngagementCommandService` writes likes to the POSTGRES `likes` table
 * (`db/schema/engagement.ts`), and `posts.controller.ts` still imports
 * `Like from '../models/Like'` and reads Mongo here (`Like.find` /
 * `Like.countDocuments`, and the same in `getPostLikes`). Two consequences, both
 * silent:
 *
 *  - every like written since the port is invisible to this endpoint, so the
 *    social-proof row on post detail is permanently empty;
 *  - the filter is now built as `{ postId: id }` with a plain STRING against a
 *    Mongoose `postId: ObjectId` field, which for a uuid v7 post id is a
 *    CastError → the catch → a 500, not an empty 200.
 *
 * Until the reads move, this suite necessarily still drives the Mongoose model,
 * because that is what the controller calls. It is written as BEHAVIOUR rather
 * than as filter-shape assertions wherever that is possible — the previous
 * version asserted `filter.postId` was a `mongoose.Types.ObjectId`, which the
 * controller no longer constructs at all — and the two claims that can only be
 * made about the query (the `$in` cap, the exact-`postId` bound) are labelled as
 * such. When `getKnownPostLikers` moves to the `likes` table, this file should
 * be rewritten against real rows: seed likes for a viewer's followees and assert
 * on the returned likers.
 */
vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

const hoisted = vi.hoisted(() => ({
  find: vi.fn(),
  countDocuments: vi.fn(),
  createScopedOxyClient: vi.fn(),
  resolveUserSummaries: vi.fn(),
}));

vi.mock('../../models/Like', () => ({
  default: {
    find: hoisted.find,
    countDocuments: hoisted.countDocuments,
  },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: hoisted.createScopedOxyClient,
  getServiceOxyClient: () => ({ getUserById: vi.fn(), getUsersByIds: vi.fn(async () => []) }),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries: hoisted.resolveUserSummaries,
  degradedActorSummary: (id: string) => ({
    id,
    username: '',
    name: { displayName: 'Unknown user' },
  }),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { getKnownPostLikers } from '../../controllers/posts.controller';

const scope = serviceScope('known-post-likers');
const VIEWER = scope.user('viewer');

/** The post the endpoint is about. A real row, so the id is a real post id. */
let postId: string;

function buildRequest(overrides: Record<string, unknown> = {}) {
  return {
    params: { id: postId },
    query: {},
    headers: {},
    ...overrides,
  };
}

function buildResponse() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

/** Chainable `Like.find(...).limit(...).select(...).lean()` stub. */
function stubFind(rows: { userId: string }[]) {
  hoisted.find.mockReturnValue({
    limit: () => ({
      select: () => ({
        lean: async () => rows,
      }),
    }),
  });
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
  postId = (await seedPost(scope, { oxyUserId: scope.user('author') })).id;
  hoisted.resolveUserSummaries.mockResolvedValue(new Map());
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('getKnownPostLikers', () => {
  it('answers an anonymous viewer with an empty result and a 200, never a 401', async () => {
    hoisted.createScopedOxyClient.mockReturnValue(undefined);
    const { res, captured } = buildResponse();

    await getKnownPostLikers(buildRequest() as never, res as never);

    expect(captured.status).toBeUndefined();
    expect(captured.body).toEqual({ likers: [], total: 0 });
    expect(hoisted.find).not.toHaveBeenCalled();
    expect(hoisted.countDocuments).not.toHaveBeenCalled();
  });

  it('short-circuits a viewer who follows nobody without querying likes', async () => {
    hoisted.createScopedOxyClient.mockReturnValue({
      getViewerGraph: async () => ({ followingIds: [], mutualIds: [], blockedIds: [] }),
    });
    const { res, captured } = buildResponse();

    await getKnownPostLikers(buildRequest({ user: { id: VIEWER } }) as never, res as never);

    expect(captured.body).toEqual({ likers: [], total: 0 });
    expect(hoisted.find).not.toHaveBeenCalled();
    expect(hoisted.countDocuments).not.toHaveBeenCalled();
  });

  it('returns only the likers the viewer follows, resolved through the canonical path', async () => {
    const followA = scope.user('follow-a');
    const followB = scope.user('follow-b');
    hoisted.createScopedOxyClient.mockReturnValue({
      getViewerGraph: async () => ({
        followingIds: [followA, followB],
        mutualIds: [],
        blockedIds: [],
      }),
    });
    stubFind([{ userId: followA }]);
    hoisted.countDocuments.mockResolvedValue(7);
    hoisted.resolveUserSummaries.mockResolvedValue(
      new Map([[followA, { user: { id: followA, username: 'ana', name: { displayName: 'Ana' } } }]]),
    );
    const { res, captured } = buildResponse();

    const req = buildRequest({ user: { id: VIEWER } });
    // eslint-disable-next-line no-console
    console.log('DEBUG req', JSON.stringify(req), 'client', hoisted.createScopedOxyClient(req));
    await getKnownPostLikers(req as never, res as never);

    expect(captured.body).toEqual({
      likers: [{ id: followA, username: 'ana', name: { displayName: 'Ana' } }],
      total: 7,
    });

    // The two claims that are only expressible about the QUERY, because a
    // wrong-but-correct filter is the failure mode: an unbounded `$in`, or a
    // `postId` bound that stopped being exact, both keep the endpoint returning
    // the right answer while making it scan the whole collection.
    const filter = hoisted.find.mock.calls[0][0] as Record<string, unknown>;
    expect(filter.userId).toEqual({ $in: [followA, followB] });
    // The post id is bound EXACTLY — never a range or a regex — and it is the id
    // of the row that actually exists.
    expect(filter.postId).toBe(postId);
    // Downvotes share the collection; only real likes are social proof.
    expect(filter.value).toBe(1);
    expect(Object.keys(filter).sort()).toEqual(['postId', 'userId', 'value']);
    // The count runs over the SAME filter, so `total` cannot drift from the sample.
    expect(hoisted.countDocuments).toHaveBeenCalledWith(filter);
  });

  it('caps the candidate width so the index scan stays bounded whatever Oxy returns', async () => {
    const huge = Array.from({ length: 9000 }, (_unused, index) => `${VIEWER}-follow-${index}`);
    hoisted.createScopedOxyClient.mockReturnValue({
      getViewerGraph: async () => ({ followingIds: huge, mutualIds: [], blockedIds: [] }),
    });
    stubFind([]);
    hoisted.countDocuments.mockResolvedValue(0);
    const { res } = buildResponse();

    await getKnownPostLikers(buildRequest({ user: { id: VIEWER } }) as never, res as never);

    const filter = hoisted.find.mock.calls[0][0] as { userId: { $in: string[] } };
    expect(filter.userId.$in).toHaveLength(5000);
    expect(filter.userId.$in[0]).toBe(`${VIEWER}-follow-0`);
  });

  it('falls back to the degraded actor rather than emitting a raw id as a handle', async () => {
    const ghost = scope.user('ghost');
    hoisted.createScopedOxyClient.mockReturnValue({
      getViewerGraph: async () => ({ followingIds: [ghost], mutualIds: [], blockedIds: [] }),
    });
    stubFind([{ userId: ghost }]);
    hoisted.countDocuments.mockResolvedValue(1);
    hoisted.resolveUserSummaries.mockResolvedValue(new Map());
    const { res, captured } = buildResponse();

    await getKnownPostLikers(buildRequest({ user: { id: VIEWER } }) as never, res as never);

    expect(captured.body).toEqual({
      likers: [{ id: ghost, username: '', name: { displayName: 'Unknown user' } }],
      total: 1,
    });
  });

  it('rejects an empty post id instead of querying for it', async () => {
    hoisted.createScopedOxyClient.mockReturnValue(undefined);
    const { res, captured } = buildResponse();

    await getKnownPostLikers(buildRequest({ params: { id: '' } }) as never, res as never);

    expect(captured.status).toBe(400);
    expect(hoisted.find).not.toHaveBeenCalled();
  });

  it('answers 200 + empty for a post id that names no row', async () => {
    // A `text` primary key holds both ObjectId hex and uuid v7, so there is no
    // id SHAPE to reject any more — an unknown id is simply a post with no known
    // likers, which is a 200, not a 400. (Previously this asserted a 400 for a
    // non-ObjectId string; that check went away with the cast.)
    hoisted.createScopedOxyClient.mockReturnValue({
      getViewerGraph: async () => ({ followingIds: [scope.user('a')], mutualIds: [], blockedIds: [] }),
    });
    stubFind([]);
    hoisted.countDocuments.mockResolvedValue(0);
    const { res, captured } = buildResponse();

    await getKnownPostLikers(
      buildRequest({ params: { id: 'not-an-object-id' }, user: { id: VIEWER } }) as never,
      res as never,
    );

    expect(captured.status).toBeUndefined();
    expect(captured.body).toEqual({ likers: [], total: 0 });
  });
});
