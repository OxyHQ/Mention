import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Offline, model-level test for the federated-boost-count backfill.
 *
 * `Post.find` (the ascending `_id` page cursor), `Post.countDocuments` (the
 * per-post federated-boost count) and `Post.bulkWrite` are mocked over a small
 * in-memory store, so the REAL paging, idempotency skip, and write shape run
 * WITHOUT MongoDB — mirroring the convention from `backfillPostLanguages.test.ts`
 * (the repo has no `mongodb-memory-server` and globally mocks mongoose).
 */

interface StoredPost {
  _id: mongoose.Types.ObjectId;
  stats?: { federatedBoostsCount?: number };
}

/** A boost `Post` row that references an original via `boostOf`. */
interface StoredBoost {
  boostOf: string;
  type: string;
  federation?: { activityId?: string };
}

interface CapturedOp {
  updateOne: { filter: { _id: mongoose.Types.ObjectId }; update: { $set: Record<string, unknown> } };
}

const h = vi.hoisted(() => {
  const state: { posts: StoredPost[]; boosts: StoredBoost[] } = { posts: [], boosts: [] };
  return { state, find: vi.fn(), countDocuments: vi.fn(), bulkWrite: vi.fn() };
});

vi.mock('../models/Post', () => ({
  Post: { find: h.find, countDocuments: h.countDocuments, bulkWrite: h.bulkWrite },
}));

import { backfillFederatedBoostCounts } from '../scripts/backfillFederatedBoostCounts';

beforeEach(() => {
  h.state.posts = [];
  h.state.boosts = [];
  h.find.mockReset();
  h.countDocuments.mockReset();
  h.bulkWrite.mockReset();

  h.find.mockImplementation((query: { _id?: { $gt?: mongoose.Types.ObjectId } }) => ({
    sort: () => ({
      limit: (n: number) => ({
        lean: async () => {
          const gt = query._id?.$gt;
          return h.state.posts
            .filter((p) => !gt || p._id.toString() > gt.toString())
            .sort((a, b) => a._id.toString().localeCompare(b._id.toString()))
            .slice(0, n);
        },
      }),
    }),
  }));

  // Mirror the script's query: a federated boost references the original via
  // `boostOf`, is `type: 'boost'`, and carries a `federation.activityId`.
  h.countDocuments.mockImplementation(async (query: { boostOf: string }) =>
    h.state.boosts.filter(
      (b) => b.boostOf === query.boostOf && b.type === 'boost' && b.federation?.activityId != null,
    ).length,
  );

  h.bulkWrite.mockImplementation(async (ops: CapturedOp[]) => {
    for (const op of ops) {
      const target = h.state.posts.find((p) => p._id.toString() === op.updateOne.filter._id.toString());
      if (!target) continue;
      const set = op.updateOne.update.$set;
      target.stats = {
        ...target.stats,
        federatedBoostsCount: set['stats.federatedBoostsCount'] as number,
      };
    }
    return { modifiedCount: ops.length };
  });
});

describe('backfillFederatedBoostCounts', () => {
  it('counts only federated Announces (not native reposts) and is idempotent', async () => {
    const id = new mongoose.Types.ObjectId();
    const boostOf = id.toString();
    h.state.posts = [{ _id: id }]; // pre-field doc: no federatedBoostsCount
    h.state.boosts = [
      { boostOf, type: 'boost', federation: { activityId: 'https://remote/a1' } },
      { boostOf, type: 'boost', federation: { activityId: 'https://remote/a2' } },
      // Native repost — no federation.activityId → must NOT be counted.
      { boostOf, type: 'boost' },
    ];

    const first = await backfillFederatedBoostCounts({ batchSize: 100 });
    expect(first.scanned).toBe(1);
    expect(first.updated).toBe(1);

    const after = h.state.posts.find((p) => p._id.equals(id));
    expect(after?.stats?.federatedBoostsCount).toBe(2);

    // Second run finds the count already correct (idempotent — no writes).
    h.bulkWrite.mockClear();
    const second = await backfillFederatedBoostCounts({ batchSize: 100 });
    expect(second.updated).toBe(0);
    expect(h.bulkWrite).not.toHaveBeenCalled();
  });

  it('leaves posts with no federated boosts untouched (no write)', async () => {
    const id = new mongoose.Types.ObjectId();
    h.state.posts = [{ _id: id, stats: { federatedBoostsCount: 0 } }];
    h.state.boosts = [{ boostOf: id.toString(), type: 'boost' }]; // native only

    const result = await backfillFederatedBoostCounts({ batchSize: 100 });

    expect(result.scanned).toBe(1);
    expect(result.updated).toBe(0);
    expect(h.bulkWrite).not.toHaveBeenCalled();
  });

  it('does not write when dryRun is set, but still reports what it would update', async () => {
    const id = new mongoose.Types.ObjectId();
    h.state.posts = [{ _id: id }];
    h.state.boosts = [{ boostOf: id.toString(), type: 'boost', federation: { activityId: 'https://remote/a1' } }];

    const result = await backfillFederatedBoostCounts({ dryRun: true });

    expect(result.updated).toBe(1);
    expect(h.bulkWrite).not.toHaveBeenCalled();
    expect(h.state.posts[0].stats?.federatedBoostsCount).toBeUndefined();
  });
});
