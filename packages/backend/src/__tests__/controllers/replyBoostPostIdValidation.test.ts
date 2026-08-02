import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A client-supplied post id must be a post id before it reaches a query.
 *
 * ## Why this is a real check and not tidiness
 *
 * `postId` / `originalPostId` come out of `req.body` as parsed JSON, so they can
 * be objects, and both handlers passed them to `Post.findById` behind nothing
 * but a truthiness test. Measured against a real mongod on mongoose 8.24.1:
 *
 *   findById({ $ne: null })          -> MATCHED an arbitrary post
 *   findByIdAndUpdate({ $ne: null }) -> MUTATED an arbitrary post
 *   findById({ $gt: '' } | 123 | {} | 'aaaaaaaaaaaa') -> CastError
 *
 * So the cast is not a guard: an operator whose operand is itself castable goes
 * straight through. Reaching the counter update was blocked only because
 * `parentPostId` and `boostOf` are String columns and `.save()` threw first —
 * an unrelated schema detail, and a 500 where a 400 belongs.
 *
 * ## What these assertions are worth
 *
 * Each asserts BOTH the 400 and that `Post.findById` was never called. The
 * status alone would keep passing if the guard moved below the query, which is
 * the arrangement that still leaks: the arbitrary post has already been read by
 * then.
 */
vi.mock('../../services/postEngagementBroadcast', () => ({
  emitPostEngagement: vi.fn(),
  POST_ENGAGEMENT_EVENTS: {
    LIKED: 'post:liked',
    UNLIKED: 'post:unliked',
    BOOSTED: 'post:boosted',
    UNBOOSTED: 'post:unboosted',
    SAVED: 'post:saved',
    UNSAVED: 'post:unsaved',
    REPLIED: 'post:replied',
  },
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
}));

import { Post } from '../../models/Post';
import { feedController } from '../../controllers/feed.controller';

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

/**
 * Values a JSON body can carry that are not post ids. `{ $ne: null }` is the one
 * that actually selected a document; the rest reached the driver and threw,
 * which is a 500 for what is plainly a bad request.
 */
const HOSTILE_IDS: Array<[string, unknown]> = [
  ['a query operator', { $ne: null }],
  ['a comparison operator', { $gt: '' }],
  ['an array', ['aaaaaaaaaaaaaaaaaaaaaaaa']],
  ['a bare number', 123],
  ['an empty object', {}],
  ['a boolean', true],
  ['a non-hex string', 'notanobjectid'],
];

describe('createReply / createBoost reject a post id that is not one', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(HOSTILE_IDS)('createReply refuses %s without querying', async (_label, postId) => {
    const findById = vi.spyOn(Post, 'findById');
    const { res, captured } = buildResponse();

    await feedController.createReply(
      { body: { postId, content: 'hello' }, user: { id: 'attacker' } } as never,
      res as never,
    );

    expect(captured.status).toBe(400);
    expect(findById).not.toHaveBeenCalled();
  });

  it.each(HOSTILE_IDS)('createBoost refuses %s without querying', async (_label, originalPostId) => {
    const findById = vi.spyOn(Post, 'findById');
    const { res, captured } = buildResponse();

    await feedController.createBoost(
      { body: { originalPostId }, user: { id: 'attacker' } } as never,
      res as never,
    );

    expect(captured.status).toBe(400);
    expect(findById).not.toHaveBeenCalled();
  });

  it('still lets a real post id through to the query', async () => {
    // The floor under the assertions above: they would all pass just as well
    // against a handler that refused every id it was ever given.
    const findById = vi.spyOn(Post, 'findById').mockImplementation((() => ({
      maxTimeMS: () => ({ lean: () => Promise.resolve(null) }),
    })) as never);
    const { res, captured } = buildResponse();

    await feedController.createReply(
      { body: { postId: 'aaaaaaaaaaaaaaaaaaaaaaaa', content: 'hello' }, user: { id: 'author' } } as never,
      res as never,
    );

    expect(findById).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaa');
    // 404, because the stub says no such post — the point is that it got there.
    expect(captured.status).toBe(404);
  });
});
