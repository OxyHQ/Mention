import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostType } from '@mention/shared-types';

/**
 * `PATCH /posts/:id/lane` — the write path that moves a post between the
 * author's own lanes, against real rows.
 *
 * It deliberately carries NO EDIT WINDOW, and that is the single most likely
 * thing for somebody to "fix" later by copying the 30-minute guard out of
 * `updatePost`. The window exists because rewriting the TEXT of a post people
 * have read is a trust problem; moving a post between the author's own
 * carriageways changes no text, does not federate, emits no MTN record and does
 * not set `isEdited`. Pinning already has no window for the same reason.
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { clearPostScope, postScope, seedLane, seedPost } from '../helpers/postFixtures';

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: vi.fn(() => ({ id: 'unknown', username: '' })),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  createUserScopedOxyServices: vi.fn(() => undefined),
  getServiceOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

import { updatePostLane } from '../../controllers/posts.controller';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const scope = postScope('post-lane-write');
const USER_ID = scope.user('author');

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function makeReq(postId: string, body: Record<string, unknown>): OxyAuthRequest {
  return { user: { id: USER_ID }, params: { id: postId }, body } as unknown as OxyAuthRequest;
}

/** The stored `lane_id`, which is what the handler is judged on. */
async function storedLaneId(postId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ laneId: posts.laneId })
    .from(posts)
    .where(eq(posts.id, postId));
  return row?.laneId ?? null;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  vi.clearAllMocks();
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('PATCH /posts/:id/lane', () => {
  it('moves the post and answers with the new lane summary', async () => {
    const laneId = await seedLane(scope, { name: 'Dev', displayMode: 'tab' });
    const post = await seedPost(scope, { oxyUserId: USER_ID });
    const res = makeRes();

    await updatePostLane(makeReq(post.id, { laneId }), res as never);

    expect(res.statusCode).toBe(200);
    expect(await storedLaneId(post.id)).toBe(laneId);
    // The `{data}` envelope, matching every OTHER lane endpoint — this handler
    // sits on the posts router but its only client reads the Lanes feature.
    expect(res.body).toEqual({
      data: { postId: post.id, lane: { id: laneId, name: 'Dev', displayMode: 'tab' } },
      message: 'Post lane updated',
    });
  });

  it('stores NULL when the lane is cleared, which the partial index excludes', async () => {
    const laneId = await seedLane(scope);
    const post = await seedPost(scope, { oxyUserId: USER_ID, laneId });
    const res = makeRes();

    await updatePostLane(makeReq(post.id, { laneId: null }), res as never);

    expect(res.statusCode).toBe(200);
    // Mongo needed `$unset` because `post_lane_chrono_v1` was partial on
    // `{ laneId: { $exists: true } }` and a stored `null` SATISFIED it, leaving a
    // laneless post indexed forever. The Postgres filter is `lane_id is not
    // null`, so null is exactly the state that stays out of the index — absent
    // and null are one state here rather than two that can disagree.
    expect(await storedLaneId(post.id)).toBeNull();
    expect(res.body).toMatchObject({ data: { lane: null } });
  });

  it('has NO edit window — an old post moves exactly like a new one', async () => {
    // Deliberately far outside the 30-minute window `updatePost` enforces.
    const laneId = await seedLane(scope);
    const post = await seedPost(scope, {
      oxyUserId: USER_ID,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    const res = makeRes();

    await updatePostLane(makeReq(post.id, { laneId }), res as never);

    expect(res.statusCode).toBe(200);
    expect(await storedLaneId(post.id)).toBe(laneId);
  });

  it('scopes the lookup to the caller, so somebody else\'s post is a 404', async () => {
    const laneId = await seedLane(scope);
    const mine = await seedPost(scope, { oxyUserId: USER_ID });
    const theirs = await seedPost(scope, { oxyUserId: scope.user('somebody-else') });

    const ok = makeRes();
    await updatePostLane(makeReq(mine.id, { laneId }), ok as never);
    expect(ok.statusCode).toBe(200);

    const forbidden = makeRes();
    await updatePostLane(makeReq(theirs.id, { laneId }), forbidden as never);
    expect(forbidden.statusCode).toBe(404);
    expect(await storedLaneId(theirs.id)).toBeNull();

    const missing = makeRes();
    await updatePostLane(makeReq('post-lane-write-no-such-post', { laneId }), missing as never);
    expect(missing.statusCode).toBe(404);
  });

  it('refuses a lane on a reply and on a boost', async () => {
    const laneId = await seedLane(scope);
    const parent = await seedPost(scope, { oxyUserId: USER_ID });
    const reply = await seedPost(scope, { oxyUserId: USER_ID, parentPostId: parent.id });
    const boost = await seedPost(scope, {
      oxyUserId: USER_ID,
      type: PostType.BOOST,
      content: {},
      boostOf: parent.id,
    });

    const replyRes = makeRes();
    await updatePostLane(makeReq(reply.id, { laneId }), replyRes as never);
    expect(replyRes.statusCode).toBe(400);

    const boostRes = makeRes();
    await updatePostLane(makeReq(boost.id, { laneId }), boostRes as never);
    expect(boostRes.statusCode).toBe(400);

    expect(await storedLaneId(reply.id)).toBeNull();
    expect(await storedLaneId(boost.id)).toBeNull();
  });

  it('answers 404 for a lane the caller does not own', async () => {
    const foreign = await seedLane(scope, { ownerId: scope.user('somebody-else') });
    const post = await seedPost(scope, { oxyUserId: USER_ID });
    const res = makeRes();

    await updatePostLane(makeReq(post.id, { laneId: foreign }), res as never);

    expect(res.statusCode).toBe(404);
    expect(await storedLaneId(post.id)).toBeNull();
  });

  it('rejects a body that is neither a lane id nor an explicit null', async () => {
    const post = await seedPost(scope, { oxyUserId: USER_ID });
    const res = makeRes();
    await updatePostLane(makeReq(post.id, {}), res as never);
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = makeRes();
    await updatePostLane(
      { params: { id: 'x' }, body: {} } as unknown as OxyAuthRequest,
      res as never,
    );
    expect(res.statusCode).toBe(401);
  });
});


/**
 * A CHANNEL post is not reachable through this route at all, and that is the
 * whole of its channel story now.
 *
 * The lookup is scoped by `{ id, oxy_user_id: userId }`, and a channel is an Oxy
 * account that AUTHORS its own posts — so a channel post's `oxyUserId` is the
 * channel, never the caller, and the query simply does not match. The old
 * deanonymization here (a channel post measured against the CALLER's personal
 * lanes, then served on a lane tab scoped to that one author) is unreachable by
 * construction rather than by a passed-through field.
 *
 * The cost is a real gap, stated rather than hidden: a channel post's lane cannot
 * be MOVED after creation through this route. It can still be set at creation,
 * where `PostCreationService` measures it against the post's actual owner.
 *
 * These are ROW assertions rather than "was the lookup called with these
 * arguments", and the pair is deliberate: a 404 on its own passes against a
 * route that refuses everything, so the CONTROL — the same caller, the same
 * lane, a post they authored — is what makes the first case about the channel.
 */
describe('PATCH /posts/:id/lane — a channel post is not this caller\'s to move', () => {
  const CHANNEL_ACCOUNT = scope.user('channel-account');

  it('404s a post the channel authored, and writes nothing', async () => {
    const personalLane = await seedLane(scope, { ownerId: USER_ID });
    const post = await seedPost(scope, { oxyUserId: CHANNEL_ACCOUNT });
    const res = makeRes();

    await updatePostLane(makeReq(post.id, { laneId: personalLane }), res as never);

    // The lane exists and belongs to the caller — the post does not, which is
    // precisely what the ownership-scoped lookup finds nothing for.
    expect(res.statusCode).toBe(404);
    expect(await storedLaneId(post.id)).toBeNull();
    expect(CHANNEL_ACCOUNT).not.toBe(USER_ID);
  });

  it('CONTROL: the same caller moves their OWN post into that same lane', async () => {
    const personalLane = await seedLane(scope, { ownerId: USER_ID });
    const post = await seedPost(scope, { oxyUserId: USER_ID });
    const res = makeRes();

    await updatePostLane(makeReq(post.id, { laneId: personalLane }), res as never);

    // The opposite outcome from one changed fact — who authored the post — which
    // is what makes the case above about the author rather than about the lane
    // being unreachable for some other reason.
    expect(res.statusCode).toBe(200);
    expect(await storedLaneId(post.id)).toBe(personalLane);
  });
});
