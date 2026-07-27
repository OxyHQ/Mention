import mongoose, { type ClientSession, Types } from 'mongoose';
import Bookmark from '../models/Bookmark';
import Post from '../models/Post';
import {
  PostRecentReplier,
  POST_RECENT_REPLIER_LIMIT,
  type RecentReplierEntry,
} from '../models/PostRecentReplier';
import { PostVisibility } from '@mention/shared-types';
import { logger } from '../utils/logger';

const RECONCILIATION_BATCH_SIZE = 100;
const MAX_TRANSACTION_ATTEMPTS = 3;
const TRANSACTION_OPTIONS = {
  readPreference: 'primary' as const,
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
};

interface SaveCountRow {
  _id: Types.ObjectId;
  count: number;
}

interface RecentReplierRow {
  _id: string;
  repliers: RecentReplierEntry[];
}

export interface EngagementProjectionReconciliationResult {
  saveBatches: number;
  recentReplierBatches: number;
}

function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: unknown;
    hasErrorLabel?: (label: string) => boolean;
  };
  if (
    typeof candidate.hasErrorLabel === 'function' &&
    (
      candidate.hasErrorLabel('TransientTransactionError') ||
      candidate.hasErrorLabel('UnknownTransactionCommitResult')
    )
  ) {
    return true;
  }
  return [11000, 112, 246, 251].includes(Number(candidate.code));
}

async function runTransactionWithRetry(
  work: (session: ClientSession) => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => work(session), TRANSACTION_OPTIONS);
      return;
    } catch (error) {
      lastError = error;
      if (
        attempt === MAX_TRANSACTION_ATTEMPTS ||
        !isRetryableTransactionError(error)
      ) {
        throw error;
      }
    } finally {
      await session.endSession();
    }
  }
  throw lastError;
}

async function reconcileSaveBatch(postIds: readonly Types.ObjectId[]): Promise<void> {
  if (postIds.length === 0) return;
  await runTransactionWithRetry(async (session) => {
    const counts = await Bookmark.aggregate<SaveCountRow>([
      { $match: { postId: { $in: postIds } } },
      { $group: { _id: '$postId', count: { $sum: 1 } } },
    ]).session(session);
    const countByPost = new Map(
      counts.map((row) => [row._id.toHexString(), Math.max(0, row.count)]),
    );
    await Post.bulkWrite(
      postIds.map((postId) => ({
        updateOne: {
          filter: { _id: postId },
          update: {
            $set: {
              'stats.savesCount': countByPost.get(postId.toHexString()) ?? 0,
            },
          },
        },
      })),
      { ordered: false, session },
    );
  });
}

async function reconcileRecentReplierBatch(postIds: readonly string[]): Promise<void> {
  if (postIds.length === 0) return;
  await runTransactionWithRetry(async (session) => {
    const rows = await Post.aggregate<RecentReplierRow>([
      {
        $match: {
          parentPostId: { $in: postIds },
          visibility: PostVisibility.PUBLIC,
          status: 'published',
          oxyUserId: { $type: 'string', $ne: '' },
        },
      },
      { $sort: { parentPostId: 1, createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: {
            postId: '$parentPostId',
            oxyUserId: '$oxyUserId',
          },
          repliedAt: { $first: '$createdAt' },
          replyId: { $first: '$_id' },
        },
      },
      { $sort: { '_id.postId': 1, repliedAt: -1, replyId: -1 } },
      {
        $group: {
          _id: '$_id.postId',
          repliers: {
            $push: {
              oxyUserId: '$_id.oxyUserId',
              repliedAt: '$repliedAt',
            },
          },
        },
      },
      {
        $project: {
          repliers: { $slice: ['$repliers', POST_RECENT_REPLIER_LIMIT] },
        },
      },
    ]).session(session);
    const repliersByPost = new Map(
      rows.map((row) => [String(row._id), row.repliers]),
    );
    const now = new Date();
    await PostRecentReplier.bulkWrite(
      postIds.map((postId) => {
        const repliers = repliersByPost.get(postId);
        if (!repliers || repliers.length === 0) {
          return { deleteOne: { filter: { postId } } };
        }
        return {
          updateOne: {
            filter: { postId },
            update: {
              $set: { postId, repliers, updatedAt: now },
              $setOnInsert: { createdAt: now },
            },
            upsert: true,
          },
        };
      }),
      { ordered: false, session },
    );
  });
}

async function processObjectIdCandidates(
  candidates: AsyncIterable<{ _id: unknown }>,
): Promise<number> {
  let batches = 0;
  let batch: Types.ObjectId[] = [];
  for await (const row of candidates) {
    if (!Types.ObjectId.isValid(String(row._id))) continue;
    batch.push(new Types.ObjectId(String(row._id)));
    if (batch.length < RECONCILIATION_BATCH_SIZE) continue;
    await reconcileSaveBatch(batch);
    batches += 1;
    batch = [];
  }
  if (batch.length > 0) {
    await reconcileSaveBatch(batch);
    batches += 1;
  }
  return batches;
}

async function processStringCandidates(
  candidates: AsyncIterable<{ _id?: unknown; postId?: unknown }>,
): Promise<number> {
  let batches = 0;
  let batch: string[] = [];
  for await (const row of candidates) {
    const id = String(row._id ?? row.postId ?? '').trim();
    if (!id) continue;
    batch.push(id);
    if (batch.length < RECONCILIATION_BATCH_SIZE) continue;
    await reconcileRecentReplierBatch(batch);
    batches += 1;
    batch = [];
  }
  if (batch.length > 0) {
    await reconcileRecentReplierBatch(batch);
    batches += 1;
  }
  return batches;
}

/**
 * Post-rollout reconciliation for projections whose legacy writers did not
 * maintain them. Each batch reads the authoritative relationships and replaces
 * the projection inside one snapshot transaction. New engagement writers touch
 * the same Post/projection row, so concurrent writes either serialize after the
 * repair or force its transaction to retry with a fresh snapshot.
 */
export async function reconcileEngagementProjections(): Promise<EngagementProjectionReconciliationResult> {
  let saveBatches = 0;
  let recentReplierBatches = 0;

  // First repair stale positive counters (including posts whose last bookmark
  // was removed by a legacy writer), then every post that currently has at
  // least one authoritative Bookmark.
  saveBatches += await processObjectIdCandidates(
    Post.find({ 'stats.savesCount': { $gt: 0 } })
      .select({ _id: 1 })
      .lean()
      .cursor(),
  );
  saveBatches += await processObjectIdCandidates(
    Bookmark.aggregate<{ _id: Types.ObjectId }>([
      { $group: { _id: '$postId' } },
    ]).cursor({ batchSize: RECONCILIATION_BATCH_SIZE }),
  );

  // Existing projection rows cover stale/deleted replies. The authoritative
  // parent-id pass covers parents that legacy writers never projected.
  recentReplierBatches += await processStringCandidates(
    PostRecentReplier.find({})
      .select({ _id: 0, postId: 1 })
      .lean()
      .cursor(),
  );
  recentReplierBatches += await processStringCandidates(
    Post.aggregate<{ _id: string }>([
      {
        $match: {
          parentPostId: { $type: 'string', $ne: '' },
          visibility: PostVisibility.PUBLIC,
          status: 'published',
          oxyUserId: { $type: 'string', $ne: '' },
        },
      },
      { $group: { _id: '$parentPostId' } },
    ]).cursor({ batchSize: RECONCILIATION_BATCH_SIZE }),
  );

  const result = { saveBatches, recentReplierBatches };
  logger.info('[EngagementProjectionReconciliation] complete', result);
  return result;
}
