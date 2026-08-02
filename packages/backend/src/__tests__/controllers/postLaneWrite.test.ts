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
import {
  clearPostScope,
  postScope,
  seedChannel,
  seedLane,
  seedPost,
} from '../helpers/postFixtures';

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: vi.fn(() => ({ id: 'unknown', username: '' })),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
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
 * A CHANNEL post may not take a PERSONAL lane — and this path is the one that let
 * it, because it never read `channel_id` and so never passed it to
 * `assertLaneAssignable`.
 *
 * The validator derives the publisher as `channelId ? 'channel' : 'user'`, so
 * without it a channel post is measured against the CALLER's own lanes. Two
 * invariants break at once, and the second is the serious one:
 *
 *  1. "a post with `channelId` never appears on its author's profile"
 *     (`shared-types/src/channel.ts`, rule 3);
 *  2. it DEANONYMIZES. `laneSource`'s user branch scopes by `oxy_user_id` and
 *     deliberately does NOT apply the channel exclusion, on the stated grounds
 *     that the pairing is impossible by construction. Under `signPosts: false`
 *     the DTO is anonymous but the SURFACE is scoped to one author, so a reader
 *     of that lane tab learns who wrote every "Unknown user" post on it.
 *
 * These are ROW assertions rather than "was the lookup called with these
 * arguments". The omission that caused the bug was a missing PROJECTION — the
 * handler read a row that did not carry `channelId` — and a call-argument
 * assertion is exactly what cannot see that: it observes the argument the
 * handler passed, having been handed the field by a mock that always supplies it.
 */
describe('PATCH /posts/:id/lane — channel posts', () => {
  it('404s a channel post pointed at one of the caller\'s PERSONAL lanes', async () => {
    const channelId = await seedChannel(scope);
    const personalLane = await seedLane(scope, { ownerType: 'user', ownerId: USER_ID });
    const post = await seedPost(scope, { oxyUserId: USER_ID, channelId });

    const res = makeRes();
    await updatePostLane(makeReq(post.id, { laneId: personalLane }), res as never);

    // The lane exists and belongs to the caller, but not to the channel — which
    // is precisely what the channel-scoped lookup finds nothing for.
    expect(res.statusCode).toBe(404);
    expect(await storedLaneId(post.id)).toBeNull();
  });

  it('accepts a lane the CHANNEL owns', async () => {
    const channelId = await seedChannel(scope);
    const channelLane = await seedLane(scope, { ownerType: 'channel', ownerId: channelId });
    const post = await seedPost(scope, { oxyUserId: USER_ID, channelId });

    const res = makeRes();
    await updatePostLane(makeReq(post.id, { laneId: channelLane }), res as never);

    expect(res.statusCode).toBe(200);
    expect(await storedLaneId(post.id)).toBe(channelLane);
  });

  it('CONTROL: an ordinary post still takes the caller\'s own lane', async () => {
    const personalLane = await seedLane(scope, { ownerType: 'user', ownerId: USER_ID });
    const post = await seedPost(scope, { oxyUserId: USER_ID });

    const res = makeRes();
    await updatePostLane(makeReq(post.id, { laneId: personalLane }), res as never);

    // Same lane, same caller, no channel — and the opposite outcome to the first
    // case, which is what makes that one about the channel rather than about the
    // lane being unreachable for some other reason.
    expect(res.statusCode).toBe(200);
    expect(await storedLaneId(post.id)).toBe(personalLane);
  });

  it('CONTROL: a channel-owned lane is refused on a post with NO channel', async () => {
    const channelId = await seedChannel(scope);
    const channelLane = await seedLane(scope, { ownerType: 'channel', ownerId: channelId });
    const post = await seedPost(scope, { oxyUserId: USER_ID });

    const res = makeRes();
    await updatePostLane(makeReq(post.id, { laneId: channelLane }), res as never);

    expect(res.statusCode).toBe(404);
    expect(await storedLaneId(post.id)).toBeNull();
  });
});
