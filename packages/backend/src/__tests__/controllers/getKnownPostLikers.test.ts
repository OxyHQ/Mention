import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Unit coverage for {@link getKnownPostLikers} — the post-detail social-proof
 * endpoint (`GET /posts/:id/likes/known`).
 *
 * Three properties matter and are asserted independently:
 *
 *  1. **Anonymous viewers get 200 + empty**, never 401. The row is decorative on
 *     a PUBLIC screen, so an auth failure here would log an error per detail
 *     view for every signed-out reader.
 *  2. **A viewer who follows nobody never touches Mongo.** An empty `$in` would
 *     match nothing anyway; short-circuiting keeps a pointless query off the
 *     hottest read.
 *  3. **The filter keeps the shape the compound index can serve** — `userId`
 *     bounded by a `$in`, an EXACT `postId`, and a `$in` no wider than the cap.
 *     Measured against a 150k-like post, that shape costs 5000 keys / 0 docs
 *     examined; dropping the exact `postId` (or letting the `$in` grow
 *     unbounded) keeps the endpoint CORRECT and quietly makes it O(likes).
 *     Field ORDER inside the filter is deliberately NOT asserted — MongoDB's
 *     planner chooses an index by cost, not by BSON key order, so an assertion
 *     on it would guard nothing while implying it mattered.
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

import mongoose from 'mongoose';
import { getKnownPostLikers } from '../../controllers/posts.controller';

const POST_ID = '507f1f77bcf86cd799439011';

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

function buildRequest(overrides: Record<string, unknown> = {}) {
  return {
    params: { id: POST_ID },
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

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.resolveUserSummaries.mockResolvedValue(new Map());
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

    await getKnownPostLikers(
      buildRequest({ user: { id: 'viewer_1' } }) as never,
      res as never,
    );

    expect(captured.body).toEqual({ likers: [], total: 0 });
    expect(hoisted.find).not.toHaveBeenCalled();
    expect(hoisted.countDocuments).not.toHaveBeenCalled();
  });

  it('intersects the viewer graph with the post likes on the indexable filter shape', async () => {
    hoisted.createScopedOxyClient.mockReturnValue({
      getViewerGraph: async () => ({
        followingIds: ['follow_a', 'follow_b'],
        mutualIds: [],
        blockedIds: [],
      }),
    });
    stubFind([{ userId: 'follow_a' }]);
    hoisted.countDocuments.mockResolvedValue(7);
    hoisted.resolveUserSummaries.mockResolvedValue(
      new Map([
        ['follow_a', { user: { id: 'follow_a', username: 'ana', name: { displayName: 'Ana' } } }],
      ]),
    );
    const { res, captured } = buildResponse();

    await getKnownPostLikers(
      buildRequest({ user: { id: 'viewer_1' } }) as never,
      res as never,
    );

    const filter = hoisted.find.mock.calls[0][0] as Record<string, unknown>;
    // The three clauses the compound `{userId:1, postId:1}` index needs: a
    // bounded `$in` on userId and an EXACT postId (never a range or a regex).
    expect(filter.userId).toEqual({ $in: ['follow_a', 'follow_b'] });
    expect(filter.postId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(filter.postId)).toBe(POST_ID);
    // Downvotes share the collection; only real likes are social proof.
    expect(filter.value).toBe(1);
    expect(Object.keys(filter).sort()).toEqual(['postId', 'userId', 'value']);
    // The count runs over the SAME filter, so `total` cannot drift from the sample.
    expect(hoisted.countDocuments).toHaveBeenCalledWith(filter);

    expect(captured.body).toEqual({
      likers: [{ id: 'follow_a', username: 'ana', name: { displayName: 'Ana' } }],
      total: 7,
    });
  });

  it('caps the $in width so the index scan stays bounded whatever Oxy returns', async () => {
    const huge = Array.from({ length: 9000 }, (_unused, index) => `follow_${index}`);
    hoisted.createScopedOxyClient.mockReturnValue({
      getViewerGraph: async () => ({ followingIds: huge, mutualIds: [], blockedIds: [] }),
    });
    stubFind([]);
    hoisted.countDocuments.mockResolvedValue(0);
    const { res } = buildResponse();

    await getKnownPostLikers(
      buildRequest({ user: { id: 'viewer_1' } }) as never,
      res as never,
    );

    const filter = hoisted.find.mock.calls[0][0] as { userId: { $in: string[] } };
    expect(filter.userId.$in).toHaveLength(5000);
    expect(filter.userId.$in[0]).toBe('follow_0');
  });

  it('falls back to the degraded actor rather than emitting a raw id as a handle', async () => {
    hoisted.createScopedOxyClient.mockReturnValue({
      getViewerGraph: async () => ({ followingIds: ['ghost'], mutualIds: [], blockedIds: [] }),
    });
    stubFind([{ userId: 'ghost' }]);
    hoisted.countDocuments.mockResolvedValue(1);
    hoisted.resolveUserSummaries.mockResolvedValue(new Map());
    const { res, captured } = buildResponse();

    await getKnownPostLikers(
      buildRequest({ user: { id: 'viewer_1' } }) as never,
      res as never,
    );

    expect(captured.body).toEqual({
      likers: [{ id: 'ghost', username: '', name: { displayName: 'Unknown user' } }],
      total: 1,
    });
  });

  it('rejects a malformed post id instead of throwing a cast error', async () => {
    hoisted.createScopedOxyClient.mockReturnValue(undefined);
    const { res, captured } = buildResponse();

    await getKnownPostLikers(
      buildRequest({ params: { id: 'not-an-object-id' } }) as never,
      res as never,
    );

    expect(captured.status).toBe(400);
    expect(hoisted.find).not.toHaveBeenCalled();
  });
});
