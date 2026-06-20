/**
 * One-shot reconciliation: recompute federated post engagement counters from the
 * REAL native records that back them.
 *
 * Federated/imported posts (those carrying a `federation.activityId`) once seeded
 * their `stats.likesCount/boostsCount/commentsCount` from remote aggregate totals
 * (`note.likes/shares/replies.totalItems`). Those foreign aggregates had no
 * backing listable records here, so the counters could diverge from reality.
 *
 * Engagement is now relational and native:
 *   - a like is a `Like` doc `{ userId, postId, value: 1 }`,
 *   - a boost is a `Post` with `type: 'boost'` and `boostOf == <post _id>`,
 *   - a comment is a reply `Post` with `parentPostId == <post _id>`.
 *
 * This script recomputes each federated post's counters from those records and
 * writes them back. It is idempotent (re-running over already-correct posts is a
 * no-op), batched via a stable `_id` cursor (the filter set never changes because
 * we only mutate `stats.*`), and logs progress plus a final summary of how many
 * posts were corrected and the total absolute drift removed.
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   node dist/scripts/recomputeFederatedEngagement.js
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import Like from '../models/Like';
import { logger } from '../utils/logger';

/** Posts scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Counter writes flushed per bulkWrite chunk. */
const BULK_CHUNK_SIZE = 500;

interface FederatedPostRow {
  _id: mongoose.Types.ObjectId;
  stats?: {
    likesCount?: number;
    boostsCount?: number;
    commentsCount?: number;
  };
}

/**
 * Count the real records that back each engagement counter for a single post.
 */
async function computeRealCounts(postId: mongoose.Types.ObjectId): Promise<{
  likesCount: number;
  boostsCount: number;
  commentsCount: number;
}> {
  const postIdString = postId.toString();
  const [likesCount, boostsCount, commentsCount] = await Promise.all([
    // Likes: native Like docs (upvotes) for this post.
    Like.countDocuments({ postId, value: 1 }),
    // Boosts: native boost Posts referencing this post. `boostOf` is stored as a
    // string id, so match the stringified _id.
    Post.countDocuments({ boostOf: postIdString, type: 'boost' }),
    // Comments: reply Posts whose parent is this post.
    Post.countDocuments({ parentPostId: postIdString }),
  ]);
  return { likesCount, boostsCount, commentsCount };
}

async function recomputeFederatedEngagement(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(`[recomputeFederatedEngagement] connected to MongoDB (${dbName})`);

    const totalCount = await Post.countDocuments({
      'federation.activityId': { $exists: true, $ne: null },
    });
    logger.info(`[recomputeFederatedEngagement] ${totalCount} federated posts to scan`);

    if (totalCount === 0) {
      logger.info('[recomputeFederatedEngagement] nothing to do');
      await mongoose.disconnect();
      return;
    }

    let scanned = 0;
    let updated = 0;
    let totalDriftCorrected = 0;
    let lastId: mongoose.Types.ObjectId | null = null;
    let pendingOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];

    const flush = async (): Promise<void> => {
      if (pendingOps.length === 0) return;
      const result = await Post.bulkWrite(pendingOps, { ordered: false });
      updated += result.modifiedCount;
      pendingOps = [];
    };

    // Stable cursor: page by ascending _id over the federated-post set. The set
    // is immutable for this run because only stats.* is mutated.
    for (;;) {
      const pageFilter: Record<string, unknown> = {
        'federation.activityId': { $exists: true, $ne: null },
      };
      if (lastId) {
        pageFilter._id = { $gt: lastId };
      }

      const page = await Post.find(pageFilter, { _id: 1, stats: 1 })
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean<FederatedPostRow[]>();

      if (page.length === 0) break;

      for (const post of page) {
        const real = await computeRealCounts(post._id);
        const current = {
          likesCount: post.stats?.likesCount ?? 0,
          boostsCount: post.stats?.boostsCount ?? 0,
          commentsCount: post.stats?.commentsCount ?? 0,
        };

        const drift =
          Math.abs(current.likesCount - real.likesCount) +
          Math.abs(current.boostsCount - real.boostsCount) +
          Math.abs(current.commentsCount - real.commentsCount);

        if (drift > 0) {
          totalDriftCorrected += drift;
          pendingOps.push({
            updateOne: {
              filter: { _id: post._id },
              update: {
                $set: {
                  'stats.likesCount': real.likesCount,
                  'stats.boostsCount': real.boostsCount,
                  'stats.commentsCount': real.commentsCount,
                },
              },
            },
          });
        }

        if (pendingOps.length >= BULK_CHUNK_SIZE) {
          await flush();
        }
      }

      scanned += page.length;
      lastId = page[page.length - 1]._id;
      logger.info(
        `[recomputeFederatedEngagement] progress: scanned ${scanned}/${totalCount}, corrected ${updated}, drift removed ${totalDriftCorrected}`,
      );
    }

    await flush();

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[recomputeFederatedEngagement] done: scanned ${scanned}, corrected ${updated} posts, total drift removed ${totalDriftCorrected} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[recomputeFederatedEngagement] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  recomputeFederatedEngagement();
}

export default recomputeFederatedEngagement;
