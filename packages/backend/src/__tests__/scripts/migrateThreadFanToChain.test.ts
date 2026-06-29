import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Offline, model-level tests for the thread fan -> chain repair.
 *
 * `Post.aggregate` (candidate broken-fan groups) and `Post.find` (root ownership
 * lookup) are mocked with canned shapes, and `Post.bulkWrite` is captured. This
 * exercises the REAL re-link math, the root-ownership guard, and the per-post
 * idempotent diff WITHOUT depending on MongoDB's `$group`/`$cond` semantics
 * (which the aggregation, not this script, owns). Mirrors the in-package pattern
 * of mocking the `Post` model in `services/federationThreadLinking.test.ts`.
 */

interface CapturedOp {
  updateOne: { filter: { _id: mongoose.Types.ObjectId }; update: { $set: { parentPostId: string } } };
}

interface CandidateGroup {
  _id: string;
  count: number;
  authors: string[];
  continuations: { id: mongoose.Types.ObjectId; parentPostId: string | null }[];
}

interface RootRow {
  _id: mongoose.Types.ObjectId;
  oxyUserId?: string;
}

const h = vi.hoisted(() => {
  const state: {
    candidates: CandidateGroup[];
    roots: RootRow[];
    capturedOps: CapturedOp[];
  } = { candidates: [], roots: [], capturedOps: [] };

  const aggregate = vi.fn(async () => state.candidates);

  const find = vi.fn((query: Record<string, any>) => ({
    lean: async () => {
      const inClause = query?._id?.$in as mongoose.Types.ObjectId[] | undefined;
      if (!Array.isArray(inClause)) return [];
      const wanted = new Set(inClause.map((id) => id.toString()));
      return state.roots.filter((r) => wanted.has(r._id.toString()));
    },
  }));

  const bulkWrite = vi.fn(async (ops: CapturedOp[]) => {
    state.capturedOps.push(...ops);
    return { modifiedCount: ops.length };
  });

  return { state, aggregate, find, bulkWrite };
});

vi.mock('../../models/Post', () => ({
  Post: { aggregate: h.aggregate, find: h.find, bulkWrite: h.bulkWrite },
}));

vi.mock('../../utils/database', () => ({
  connectToDatabase: vi.fn(async () => undefined),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined as never);

import migrateThreadFanToChain from '../../scripts/migrateThreadFanToChain';

/** Build a thread group: a root authored by `author` plus `n` continuations. */
function makeFan(
  author: string,
  continuationParents: (rootId: string) => (string | null)[],
): { rootId: string; group: CandidateGroup; rootRow: RootRow } {
  const root = new mongoose.Types.ObjectId();
  const rootId = root.toString();
  const parents = continuationParents(rootId);
  // Sequentially-allocated ObjectIds preserve creation order under _id ascending.
  const continuations = parents.map((parentPostId) => ({
    id: new mongoose.Types.ObjectId(),
    parentPostId,
  }));
  return {
    rootId,
    group: { _id: rootId, count: continuations.length, authors: [author], continuations },
    rootRow: { _id: root, oxyUserId: author },
  };
}

beforeEach(() => {
  h.state.candidates = [];
  h.state.roots = [];
  h.state.capturedOps = [];
  h.aggregate.mockClear();
  h.find.mockClear();
  h.bulkWrite.mockClear();
});

describe('migrateThreadFanToChain', () => {
  it('re-links a 3-continuation fan into a sequential chain (first keeps root parent)', async () => {
    // Broken fan: all 3 continuations point at the root.
    const { rootId, group, rootRow } = makeFan('user-A', (r) => [r, r, r]);
    h.state.candidates = [group];
    h.state.roots = [rootRow];

    await migrateThreadFanToChain();

    const c0 = group.continuations[0];
    const c1 = group.continuations[1];
    const c2 = group.continuations[2];

    // C0 already correct (replies to root) -> NOT written. C1 -> C0, C2 -> C1.
    expect(h.state.capturedOps).toHaveLength(2);
    const byTarget = new Map(h.state.capturedOps.map((op) => [op.updateOne.filter._id.toString(), op.updateOne.update.$set.parentPostId]));
    expect(byTarget.has(c0.id.toString())).toBe(false);
    expect(byTarget.get(c1.id.toString())).toBe(c0.id.toString());
    expect(byTarget.get(c2.id.toString())).toBe(c1.id.toString());
    // Root and threadId are never touched.
    expect(byTarget.has(rootId)).toBe(false);
  });

  it('skips a thread whose root is authored by a different user (ownership guard)', async () => {
    const { group, rootRow } = makeFan('user-A', (r) => [r, r, r]);
    // Root actually belongs to someone else -> not a self-thread.
    h.state.candidates = [group];
    h.state.roots = [{ _id: rootRow._id, oxyUserId: 'user-OTHER' }];

    await migrateThreadFanToChain();

    expect(h.state.capturedOps).toHaveLength(0);
    expect(h.bulkWrite).not.toHaveBeenCalled();
  });

  it('skips a thread whose root is missing (cannot verify ownership)', async () => {
    const { group } = makeFan('user-A', (r) => [r, r, r]);
    h.state.candidates = [group];
    h.state.roots = []; // root not found

    await migrateThreadFanToChain();

    expect(h.state.capturedOps).toHaveLength(0);
  });

  it('is idempotent: an already-chained thread produces no writes', async () => {
    const root = new mongoose.Types.ObjectId();
    const rootId = root.toString();
    const c0 = new mongoose.Types.ObjectId();
    const c1 = new mongoose.Types.ObjectId();
    const c2 = new mongoose.Types.ObjectId();
    // Already a correct chain: c0 -> root, c1 -> c0, c2 -> c1.
    const continuations = [
      { id: c0, parentPostId: rootId },
      { id: c1, parentPostId: c0.toString() },
      { id: c2, parentPostId: c1.toString() },
    ];
    h.state.candidates = [{ _id: rootId, count: 3, authors: ['user-A'], continuations }];
    h.state.roots = [{ _id: root, oxyUserId: 'user-A' }];

    await migrateThreadFanToChain();

    expect(h.state.capturedOps).toHaveLength(0);
  });

  it('does nothing when there are no candidate threads', async () => {
    h.state.candidates = [];

    await migrateThreadFanToChain();

    expect(h.find).not.toHaveBeenCalled();
    expect(h.bulkWrite).not.toHaveBeenCalled();
  });
});
