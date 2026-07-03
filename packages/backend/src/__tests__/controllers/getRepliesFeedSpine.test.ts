import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Unit coverage for {@link FeedController.getRepliesFeed}'s self-thread spine
 * expansion (Bluesky-style replies).
 *
 * When the parent post is a self-thread ROOT (`threadId === <its own id>`), the
 * replies feed must surface external replies to ANY node of the OP's continuation
 * spine (root … cN), not just the root's direct children — while EXCLUDING the OP's
 * own continuations (those are rendered as the connected spine on the client). For
 * any other parent the query is the single-parent match, unchanged.
 *
 * The controller pulls in the server bootstrap + hydration/Oxy layers; stub those so
 * the test stays pure and never touches a DB or the network. `Post.findById`/
 * `Post.find` are spied so we can assert on the EXACT Mongo query the controller
 * builds.
 */
vi.mock('../../../server', () => ({
  oxy: {},
  io: { of: () => ({ emit: vi.fn() }) },
  notificationsNamespace: { emit: vi.fn() },
}));

vi.mock('../../services/PostHydrationService', () => ({
  // Passthrough hydration — the query shape we assert on is built before hydration,
  // so return the documents unchanged (they already carry `id` + `user.id`).
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
}));

import { Post } from '../../models/Post';
import { feedController } from '../../controllers/feed.controller';

const ROOT_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const C1_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const C2_ID = 'cccccccccccccccccccccccc';
const PLAIN_ID = 'dddddddddddddddddddddddd';
const OP_USER = 'op_user_1';

type AnyQuery = Record<string, unknown>;

/**
 * A minimal chainable Mongoose-query stub: every chain method returns itself and
 * `.lean()` resolves to the supplied result, matching the
 * `.select().sort().limit().maxTimeMS().lean()` call shape the controller uses.
 */
function chain(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const method of ['select', 'sort', 'limit', 'maxTimeMS']) {
    q[method] = vi.fn(() => q);
  }
  q.lean = vi.fn(() => Promise.resolve(result));
  return q;
}

function buildResponse() {
  const payload: { value?: unknown; status?: number } = {};
  const res = {
    status(code: number) {
      payload.status = code;
      return this;
    },
    json(body: unknown) {
      payload.value = body;
      return this;
    },
  };
  return { res, payload };
}

/**
 * Wire `Post.findById` to return `parent` and route the two distinct `Post.find`
 * calls (spine query vs. replies query) by inspecting the filter: the spine query is
 * the only one carrying a `threadId` clause. Returns the captured find filters.
 */
function stubModel(parent: AnyQuery | null) {
  const replyDocs = [{ _id: 'r1', id: 'r1', user: { id: 'other_user' } }];
  const continuationDocs = [{ _id: C1_ID }, { _id: C2_ID }];
  const findFilters: AnyQuery[] = [];

  vi.spyOn(Post, 'findById').mockImplementation(((): unknown => chain(parent)) as never);
  vi.spyOn(Post, 'find').mockImplementation(((filter: AnyQuery): unknown => {
    findFilters.push(filter);
    if (filter && 'threadId' in filter) return chain(continuationDocs);
    return chain(replyDocs);
  }) as never);

  return { findFilters, replyDocs };
}

describe('getRepliesFeed — self-thread spine expansion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expands a self-thread root into its whole spine and excludes the OP continuations', async () => {
    const { findFilters } = stubModel({ _id: ROOT_ID, threadId: ROOT_ID, oxyUserId: OP_USER });

    const req = { query: {}, params: { parentId: ROOT_ID } };
    const { res, payload } = buildResponse();
    await feedController.getRepliesFeed(req as never, res as never);

    // The spine query was issued (single source of truth, keyed by threadId).
    const spineFilter = findFilters.find((f) => 'threadId' in f);
    expect(spineFilter).toBeDefined();
    expect(spineFilter?.threadId).toBe(ROOT_ID);
    expect(spineFilter?.oxyUserId).toBe(OP_USER);

    // The replies query matches replies to the ROOT and every continuation …
    const repliesFilter = findFilters.find((f) => !('threadId' in f));
    expect(repliesFilter?.parentPostId).toEqual({ $in: [ROOT_ID, C1_ID, C2_ID] });

    // … while excluding the OP's own continuations by id (they render as the spine).
    const idClause = repliesFilter?._id as { $nin?: mongoose.Types.ObjectId[] };
    expect(idClause?.$nin?.map(String)).toEqual([C1_ID, C2_ID]);

    // Response shape unchanged.
    expect((payload.value as { items: unknown[] }).items).toHaveLength(1);
  });

  it('merges the pagination cursor with the continuation exclusion on _id', async () => {
    const { findFilters } = stubModel({ _id: ROOT_ID, threadId: ROOT_ID, oxyUserId: OP_USER });

    const cursorId = new mongoose.Types.ObjectId();
    const req = { query: { cursor: String(cursorId) }, params: { parentId: ROOT_ID } };
    const { res } = buildResponse();
    await feedController.getRepliesFeed(req as never, res as never);

    const repliesFilter = findFilters.find((f) => !('threadId' in f));
    const idClause = repliesFilter?._id as { $nin?: mongoose.Types.ObjectId[]; $lt?: mongoose.Types.ObjectId };
    expect(idClause?.$nin?.map(String)).toEqual([C1_ID, C2_ID]);
    expect(String(idClause?.$lt)).toBe(String(cursorId));
  });

  it('leaves a non-root parent as a single-parent query (no spine, no _id exclusion)', async () => {
    // A reply / mid-thread continuation: threadId points at the ROOT, not itself.
    const { findFilters } = stubModel({ _id: PLAIN_ID, threadId: ROOT_ID, oxyUserId: OP_USER });

    const req = { query: {}, params: { parentId: PLAIN_ID } };
    const { res } = buildResponse();
    await feedController.getRepliesFeed(req as never, res as never);

    // No spine query was issued.
    expect(findFilters.some((f) => 'threadId' in f)).toBe(false);

    const repliesFilter = findFilters.find((f) => !('threadId' in f));
    expect(repliesFilter?.parentPostId).toBe(PLAIN_ID);
    expect(repliesFilter?._id).toBeUndefined();
  });

  it('treats a parent with no threadId as a plain post (single-parent query)', async () => {
    const { findFilters } = stubModel({ _id: PLAIN_ID, oxyUserId: OP_USER });

    const req = { query: {}, params: { parentId: PLAIN_ID } };
    const { res } = buildResponse();
    await feedController.getRepliesFeed(req as never, res as never);

    expect(findFilters.some((f) => 'threadId' in f)).toBe(false);
    const repliesFilter = findFilters.find((f) => !('threadId' in f));
    expect(repliesFilter?.parentPostId).toBe(PLAIN_ID);
    expect(repliesFilter?._id).toBeUndefined();
  });
});
