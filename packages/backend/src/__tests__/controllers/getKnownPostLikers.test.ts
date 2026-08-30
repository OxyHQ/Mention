import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for {@link getKnownPostLikers} — the post-detail social-proof
 * endpoint (`GET /posts/:id/likes/known`).
 *
 * Four properties matter and are asserted independently:
 *
 *  1. **Anonymous viewers get 200 + empty**, never 401. The row is decorative on
 *     a PUBLIC screen, so an auth failure here would log an error per detail
 *     view for every signed-out reader.
 *  2. **A viewer who follows nobody never queries likes at all.** An empty `IN`
 *     would match nothing anyway; short-circuiting keeps a pointless query off
 *     the hottest read.
 *  3. **Only likers the viewer follows come back**, and `total` counts the same
 *     set the sample was drawn from.
 *  4. **The candidate set stays bounded at 5000.** Letting it grow unbounded
 *     keeps the endpoint CORRECT and quietly makes it O(likes) — the failure
 *     mode a shape assertion is usually reached for, and the one this file
 *     instead demonstrates with a like that falls off the end of the cap.
 *
 * ## What changed with the Postgres port
 *
 * The old suite replaced `models/Like` with a chainable stub and asserted on the
 * Mongo filter object the controller BUILT — including that `filter.postId` was
 * a `mongoose.Types.ObjectId`. Both the model and that cast are gone: likes live
 * in the `likes` table, `post_id` is the post's `text` primary key, and the
 * whole query is a `WHERE user_id = ANY(...) AND post_id = ... AND value = 1`.
 *
 * So there is no filter to inspect, and nothing here needs one: every claim
 * above is now made by seeding rows that must match next to rows that must not.
 * That is a strictly stronger check — a filter assertion cannot tell a correct
 * predicate from one that silently matches nothing, which is exactly what an
 * `IN` over an empty candidate list or a `post_id` compared against the wrong
 * column would do.
 *
 * The Oxy viewer graph stays mocked: it is the network boundary, and WHICH ids
 * it returns is the input the cap is about.
 */
vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => undefined,
}));

const hoisted = vi.hoisted(() => ({
  createScopedOxyClient: vi.fn(),
  resolveUserSummaries: vi.fn(),
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

import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { likes } from '../../db/schema/engagement';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { getKnownPostLikers } from '../../controllers/posts/engagementLists';

const scope = serviceScope('known-post-likers');
const VIEWER = scope.user('viewer');

/**
 * `MAX_KNOWN_LIKER_CANDIDATES` in the controller. Restated because it is not
 * exported and because the cap is one of the four properties under test — if it
 * moves, the boundary test below fails loudly rather than silently measuring
 * nothing.
 */
const CANDIDATE_CAP = 5000;
/** `KNOWN_LIKERS_SAMPLE_LIMIT` — how many avatars the row shows. */
const SAMPLE_LIMIT = 3;

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

/** Store one real like (or downvote) on the post under test. */
async function seedLike(userId: string, value: 1 | -1 = 1): Promise<void> {
  await getDb().insert(likes).values({ userId, postId, value });
}

/** Point the viewer graph at a fixed following list. */
function viewerFollows(followingIds: string[]): void {
  hoisted.createScopedOxyClient.mockReturnValue({
    getViewerGraph: async () => ({ followingIds, mutualIds: [], blockedIds: [] }),
  });
}

/** Resolve these ids to canonical Oxy summaries; anything else stays degraded. */
function resolveSummaries(entries: Array<[string, string]>): void {
  hoisted.resolveUserSummaries.mockResolvedValue(
    new Map(
      entries.map(([id, username]) => [
        id,
        { user: { id, username, name: { displayName: username } } },
      ]),
    ),
  );
}

async function callEndpoint(overrides: Record<string, unknown> = {}) {
  const { res, captured } = buildResponse();
  await getKnownPostLikers(buildRequest(overrides) as never, res as never);
  return captured;
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
  // `likes.post_id` is `ON DELETE CASCADE`, so removing the post takes its likes
  // with it — but do it explicitly first, because a like row surviving its post
  // would be invisible here and answer another test's query.
  await getDb().delete(likes).where(eq(likes.postId, postId));
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('getKnownPostLikers', () => {
  it('answers an anonymous viewer with an empty result and a 200, never a 401', async () => {
    hoisted.createScopedOxyClient.mockReturnValue(undefined);
    await seedLike(scope.user('somebody'));

    const captured = await callEndpoint();

    expect(captured.status).toBeUndefined();
    // Empty because the viewer is anonymous — NOT because there are no likes.
    expect(captured.body).toEqual({ likers: [], total: 0 });
  });

  it('short-circuits a viewer who follows nobody', async () => {
    viewerFollows([]);
    await seedLike(scope.user('somebody'));

    expect(await callEndpoint({ user: { id: VIEWER } })).toMatchObject({
      body: { likers: [], total: 0 },
    });
  });

  it('returns only the likers the viewer follows, resolved through the canonical path', async () => {
    const followed = scope.user('followed');
    const stranger = scope.user('stranger');
    viewerFollows([followed, scope.user('followed-but-silent')]);
    await seedLike(followed);
    await seedLike(stranger);
    resolveSummaries([[followed, 'ana']]);

    const captured = await callEndpoint({ user: { id: VIEWER } });

    // The stranger liked the post too and is deliberately absent: this row is
    // social proof, not a like list.
    expect(captured.body).toEqual({
      likers: [{ id: followed, username: 'ana', name: { displayName: 'ana' } }],
      total: 1,
    });
  });

  it('counts DOWNVOTES as neither likers nor total', async () => {
    // `likes` is a three-state relationship (1 / -1 / no row) and both states
    // share the table, so the `value = 1` clause is the only thing keeping a
    // downvote out of the social-proof row.
    const upvoter = scope.user('upvoter');
    const downvoter = scope.user('downvoter');
    viewerFollows([upvoter, downvoter]);
    await seedLike(upvoter, 1);
    await seedLike(downvoter, -1);
    resolveSummaries([[upvoter, 'up'], [downvoter, 'down']]);

    expect(await callEndpoint({ user: { id: VIEWER } })).toMatchObject({
      body: {
        likers: [{ id: upvoter, username: 'up', name: { displayName: 'up' } }],
        total: 1,
      },
    });
  });

  it('counts every followed liker in `total` while sampling only a few avatars', async () => {
    const followed = Array.from({ length: SAMPLE_LIMIT + 2 }, (_u, i) => scope.user(`liker-${i}`));
    viewerFollows(followed);
    for (const id of followed) await seedLike(id);

    const captured = await callEndpoint({ user: { id: VIEWER } });
    const body = captured.body as { likers: unknown[]; total: number };

    // `total` is EXACT and comes from the same predicate the sample was drawn
    // from — a total taken from the sample would read 3 here and quietly
    // under-report every busy post.
    expect(body.total).toBe(followed.length);
    expect(body.likers).toHaveLength(SAMPLE_LIMIT);
  });

  it('caps the candidate list at 5000, so a like beyond the cap cannot be found', async () => {
    // The boundary stated as data: the viewer follows 9000 accounts and two of
    // them liked the post — one INSIDE the cap and one just past it. An
    // unbounded candidate list would return both, which is the regression the
    // cap exists to prevent (measured at 5000 keys / 0 docs examined on a
    // 150k-like post).
    const inside = scope.user('inside-cap');
    const outside = scope.user('outside-cap');
    const following = Array.from({ length: 9000 }, (_u, i) => `${VIEWER}-filler-${i}`);
    following[0] = inside;
    following[CANDIDATE_CAP] = outside;
    viewerFollows(following);
    await seedLike(inside);
    await seedLike(outside);
    resolveSummaries([[inside, 'ana'], [outside, 'bob']]);

    const captured = await callEndpoint({ user: { id: VIEWER } });

    expect(captured.body).toEqual({
      likers: [{ id: inside, username: 'ana', name: { displayName: 'ana' } }],
      total: 1,
    });
    // And the row the cap excluded really is stored — so "not returned" is the
    // cap and not a missing fixture.
    const stored = await getDb()
      .select({ userId: likes.userId })
      .from(likes)
      .where(inArray(likes.userId, [inside, outside]));
    expect(stored).toHaveLength(2);
  });

  it('falls back to the degraded actor rather than emitting a raw id as a handle', async () => {
    const ghost = scope.user('ghost');
    viewerFollows([ghost]);
    await seedLike(ghost);
    hoisted.resolveUserSummaries.mockResolvedValue(new Map());

    expect(await callEndpoint({ user: { id: VIEWER } })).toMatchObject({
      body: {
        likers: [{ id: ghost, username: '', name: { displayName: 'Unknown user' } }],
        total: 1,
      },
    });
  });

  it('rejects an empty post id instead of querying for it', async () => {
    hoisted.createScopedOxyClient.mockReturnValue(undefined);

    expect(await callEndpoint({ params: { id: '' } })).toMatchObject({ status: 400 });
  });

  it('answers 200 + empty for a post id that names no row', async () => {
    // The primary key is `text` holding BOTH shapes — ObjectId hex for rows that
    // predate the cutover, uuid v7 since — so there is no id SHAPE left to
    // reject: an unknown id is a post with no known likers, which is a 200. (The
    // previous version asserted a 400 here, which only made sense while the
    // controller cast the param to an ObjectId.)
    viewerFollows([scope.user('someone')]);

    const captured = await callEndpoint({
      params: { id: 'not-an-object-id' },
      user: { id: VIEWER },
    });

    expect(captured.status).toBeUndefined();
    expect(captured.body).toEqual({ likers: [], total: 0 });
  });
});
