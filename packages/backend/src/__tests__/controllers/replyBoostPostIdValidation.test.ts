import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
 * So the cast was not a guard: an operator whose operand is itself castable went
 * straight through.
 *
 * ## What the port changed, and what it did not
 *
 * Every id is a BOUND PARAMETER against a `text` column now, so an operator
 * object can no longer become a predicate — the hole this file was written for
 * is closed by the storage layer rather than by the check. The TYPE check stays
 * anyway: a non-string has no business being interpolated as an id, and a 400
 * is the honest answer for one.
 *
 * The id-SHAPE half is GONE, and its absence is asserted below. `posts.id` holds
 * pre-cutover ObjectId hex AND post-cutover uuid v7, so an `isValidObjectId`
 * gate would 400 every post this instance has minted since the cutover — the
 * failure would be a compose action that silently stopped working, not an error.
 * A string that is simply not a post id matches no row and gets the 404 it
 * deserves.
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

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { feedController } from '../../controllers/feed.controller';

const scope = serviceScope('reply-boost-id-validation');

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

/** Values a JSON body can carry that are not, and can never be, an id STRING. */
const NON_STRING_IDS: Array<[string, unknown]> = [
  ['a query operator', { $ne: null }],
  ['a comparison operator', { $gt: '' }],
  ['an array', ['aaaaaaaaaaaaaaaaaaaaaaaa']],
  ['a bare number', 123],
  ['an empty object', {}],
  ['a boolean', true],
];

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('createReply / createBoost reject a post id that is not one', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await clearServiceScope(scope);
  });

  it.each(NON_STRING_IDS)('createReply refuses %s', async (_label, postId) => {
    const { res, captured } = buildResponse();

    await feedController.createReply(
      { body: { postId, content: 'hello' }, user: { id: scope.user('attacker') } } as never,
      res as never,
    );

    expect(captured.status).toBe(400);
  });

  it.each(NON_STRING_IDS)('createBoost refuses %s', async (_label, originalPostId) => {
    const { res, captured } = buildResponse();

    await feedController.createBoost(
      { body: { originalPostId }, user: { id: scope.user('attacker') } } as never,
      res as never,
    );

    expect(captured.status).toBe(400);
  });

  it.each([
    ['a non-hex string', 'notanobjectid'],
    ['a uuid that names no post', '019fffff-ffff-7fff-bfff-ffffffffffff'],
  ])('answers 404, not 400, for %s — a string that is simply not a post', async (_l, postId) => {
    const { res, captured } = buildResponse();

    await feedController.createReply(
      { body: { postId, content: 'hello' }, user: { id: scope.user('author') } } as never,
      res as never,
    );

    // The distinction matters: 400 would mean "that cannot be an id", and an
    // id-shape gate saying that about a uuid v7 is exactly the regression this
    // case exists to catch.
    expect(captured.status).toBe(404);
  });

  it('lets a real post id through to a real read', async () => {
    // The floor under every assertion above: they would all pass just as well
    // against a handler that refused every id it was ever given.
    const parent = await seedPost(scope, { oxyUserId: scope.user('parent-author') });
    const { res, captured } = buildResponse();

    await feedController.createReply(
      { body: { postId: parent.id, content: 'hello' }, user: { id: scope.user('author') } } as never,
      res as never,
    );

    expect(captured.status).not.toBe(400);
    expect(captured.status).not.toBe(404);
  });
});
