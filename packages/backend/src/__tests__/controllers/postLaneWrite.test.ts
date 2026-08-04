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

/**
 * The stored `lane_id`, which is what the handler is judged on.
 *
 * Every case below asserts the ROW rather than the reply, and for a specific
 * reason: an `UPDATE` whose filter matches nothing is not an error, so a write
 * scoped to the wrong id answers 200 with the new lane's summary while the post
 * has not moved. Only reading the column back tells those two apart.
 */
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

  it('looks the post up by id and authorizes separately, still 404ing a stranger', async () => {
    // The lookup is no longer the gate — it cannot be, because a channel post's
    // `oxyUserId` is the channel and scoping the query by the caller made every
    // one of them unreachable. `postManagementRefusal` is the gate now, and a
    // refusal answers the SAME 404, so nothing about the reply changed.
    //
    // Which is exactly why the fixture is a post that EXISTS and belongs to
    // somebody else: a viewer-scoped query answering nothing would pass whether
    // the authorization check existed or not.
    const laneId = await seedLane(scope);
    const mine = await seedPost(scope, { oxyUserId: USER_ID });

    const ok = makeRes();
    await updatePostLane(makeReq(mine.id, { laneId }), ok as never);
    expect(ok.statusCode).toBe(200);

    // The stranger's post gets the stranger's OWN lane, so `assertLaneAssignable`
    // would ACCEPT this pairing. That leaves `postManagementRefusal` as the only
    // thing that can produce the 404 — sharing `laneId` here instead made the
    // lane check answer it, and the case passed with the authorization deleted.
    const stranger = scope.user('somebody-else');
    const theirLane = await seedLane(scope, { ownerId: stranger });
    const theirs = await seedPost(scope, { oxyUserId: stranger });

    const forbidden = makeRes();
    await updatePostLane(makeReq(theirs.id, { laneId: theirLane }), forbidden as never);
    expect(forbidden.statusCode).toBe(404);
    // No member reader is configured in this suite, so the operator path cannot
    // admit them either — and the row is proof the refusal came before the write.
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
 * A CHANNEL post IS movable through this route — by the person who wrote it —
 * and the lane it may be moved into is the CHANNEL's, never the mover's.
 *
 * That second half is the dangerous one. A channel post carries the channel as
 * its author and a human in `writtenByOxyUserId`; measuring the lane against the
 * MOVER would offer their personal lanes, and a lane tab is scoped to one author
 * even though the post's DTO stays anonymous — so the writer's identity would be
 * recoverable from which tab the post appears on. The route therefore reads the
 * publisher off the POST, and these cases pin exactly that, in both directions.
 *
 * ## Which semantics these encode, and why it is not the branch's own
 *
 * This branch shipped the OPPOSITE answer — the lookup was narrowed by
 * `oxy_user_id = userId`, so a channel post was a 404 here and its lane could
 * never be moved after creation — and `updatePostLane` carried a written note
 * saying that the catch-up merge would have to decide between the two rather
 * than resolve them mechanically. The merged route decides for `main`: the
 * lookup is by id alone, `postManagementRefusal` authorizes, and
 * `assertLaneAssignable` is handed `post.oxyUserId`. So these are `main`'s
 * claims, re-expressed against real rows — the branch's "unreachable by
 * construction" cases would now pass for no reason at all.
 *
 * They are ROW assertions rather than "was the lookup called with these
 * arguments". `main` asserted the lane check's Mongo FILTER
 * (`{_id, ownerId: CHANNEL}`) and the update's filter; both spell a query that
 * no longer exists, and neither could tell a write that landed from one that
 * matched nothing. Seeding a lane under each owner and reading `lane_id` back
 * answers the same question about the code that actually runs.
 */
describe('PATCH /posts/:id/lane — a channel post moves against the CHANNEL\'s lanes', () => {
  const CHANNEL_ACCOUNT = scope.user('channel-account');
  const OTHER_HUMAN = scope.user('other-human');

  it('lets the WRITER move it, though the channel is the author', async () => {
    const channelLane = await seedLane(scope, { ownerId: CHANNEL_ACCOUNT });
    const post = await seedPost(scope, {
      oxyUserId: CHANNEL_ACCOUNT,
      writtenByOxyUserId: USER_ID,
    });
    const res = makeRes();

    await updatePostLane(makeReq(post.id, { laneId: channelLane }), res as never);

    expect(res.statusCode).toBe(200);
    // The ROW, because the write is scoped by the post's AUTHOR: left scoped to
    // the caller it matched nothing, which an `UPDATE` reports as success — the
    // handler answered 200 with the new lane's summary while the post stayed put.
    expect(await storedLaneId(post.id)).toBe(channelLane);
    expect(CHANNEL_ACCOUNT).not.toBe(USER_ID);
  });

  it('refuses the writer’s OWN lane, which is what would deanonymize them', async () => {
    const personalLane = await seedLane(scope, { ownerId: USER_ID });
    const post = await seedPost(scope, {
      oxyUserId: CHANNEL_ACCOUNT,
      writtenByOxyUserId: USER_ID,
    });
    const res = makeRes();

    await updatePostLane(makeReq(post.id, { laneId: personalLane }), res as never);

    // The caller may move this post (the case above proves it) and owns this
    // lane — and it is still refused, because the publisher comes off the POST.
    // A channel post on a personal lane tab recovers the writer's identity that
    // `signPosts` exists to keep undisclosed.
    expect(res.statusCode).toBe(404);
    expect(await storedLaneId(post.id)).toBeNull();
  });

  it('refuses a stranger who neither authored nor wrote it', async () => {
    const channelLane = await seedLane(scope, { ownerId: CHANNEL_ACCOUNT });
    const post = await seedPost(scope, {
      oxyUserId: CHANNEL_ACCOUNT,
      writtenByOxyUserId: OTHER_HUMAN,
    });
    const res = makeRes();

    await updatePostLane(makeReq(post.id, { laneId: channelLane }), res as never);

    expect(res.statusCode).toBe(404);
    expect(await storedLaneId(post.id)).toBeNull();
  });

  it('CONTROL: an ordinary post is still measured against its own owner', async () => {
    // Without this, every case above passes against a route that refuses
    // everything.
    const personalLane = await seedLane(scope, { ownerId: USER_ID });
    const post = await seedPost(scope, { oxyUserId: USER_ID });
    const res = makeRes();

    await updatePostLane(makeReq(post.id, { laneId: personalLane }), res as never);

    expect(res.statusCode).toBe(200);
    expect(await storedLaneId(post.id)).toBe(personalLane);
  });
});
