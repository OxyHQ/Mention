import mongoose, { type ClientSession, type PipelineStage } from 'mongoose';
import { PostVisibility } from '@mention/shared-types';
import Post from '../models/Post';
import {
  PostRecentReplier,
  POST_RECENT_REPLIER_LIMIT,
  type RecentReplierEntry,
} from '../models/PostRecentReplier';
import { logger } from '../utils/logger';

const PROJECTION_REPAIR_TRANSACTION_OPTIONS = {
  readPreference: 'primary' as const,
  readConcern: { level: 'snapshot' as const },
  writeConcern: { w: 'majority' as const },
};
const MAX_PROJECTION_REPAIR_ATTEMPTS = 3;

export interface RecentReplyLike {
  parentPostId?: unknown;
  oxyUserId?: unknown;
  createdAt?: unknown;
  visibility?: unknown;
  status?: unknown;
}

export interface RecentReplierProjection {
  perPostRepliers: Map<string, string[]>;
  allReplierIds: Set<string>;
}

export interface DeletedPostProjectionContext {
  postId: unknown;
  parentPostId?: unknown;
}

/**
 * A direct reply removed alongside its parent, in the shape
 * {@link import('./PostDeletionCascade').CascadedPostRow} consumes — the two are
 * checked against each other by the compiler at the call site in
 * `posts.controller`.
 */
export interface DeletedReplyRow {
  _id: mongoose.Types.ObjectId;
  oxyUserId?: string;
  boostOf?: string;
  parentPostId?: string;
  federation?: { activityId?: string; url?: string } | null;
  content?: { pollId?: string; article?: { articleId?: string } } | null;
}

function validDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizedId(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Pure reference implementation of the projection contract. It is also useful
 * to verify the atomic Mongo update pipeline in isolation.
 */
export function mergeRecentRepliers(
  existing: readonly RecentReplierEntry[],
  candidate: RecentReplierEntry,
): RecentReplierEntry[] {
  const newestByUser = new Map<string, Date>();
  for (const entry of [...existing, candidate]) {
    const userId = String(entry.oxyUserId ?? '');
    const repliedAt = validDate(entry.repliedAt);
    if (!userId || !repliedAt) continue;
    const previous = newestByUser.get(userId);
    if (!previous || repliedAt > previous) {
      newestByUser.set(userId, repliedAt);
    }
  }

  return [...newestByUser]
    .map(([oxyUserId, repliedAt]) => ({ oxyUserId, repliedAt }))
    .sort((left, right) => right.repliedAt.getTime() - left.repliedAt.getTime())
    .slice(0, POST_RECENT_REPLIER_LIMIT);
}

/**
 * Atomic, concurrency-safe insertion into a newest-first, unique and bounded
 * array. The pipeline preserves a newer existing reply from the same user, so
 * historical federation/backfill can arrive out of order safely.
 */
export function buildRecentReplierUpdatePipeline(
  postId: string,
  oxyUserId: string,
  repliedAt: Date,
): PipelineStage[] {
  const existingEntries = { $ifNull: ['$repliers', []] };
  const sameUserEntries = {
    $filter: {
      input: existingEntries,
      as: 'entry',
      cond: { $eq: ['$$entry.oxyUserId', oxyUserId] },
    },
  };
  const otherUserEntries = {
    $filter: {
      input: existingEntries,
      as: 'entry',
      cond: { $ne: ['$$entry.oxyUserId', oxyUserId] },
    },
  };

  return [
    {
      $set: {
        postId,
        repliers: {
          $let: {
            vars: {
              previous: { $arrayElemAt: [sameUserEntries, 0] },
              others: otherUserEntries,
            },
            in: {
              $let: {
                vars: {
                  effectiveDate: {
                    $cond: [
                      {
                        $gt: [
                          { $ifNull: ['$$previous.repliedAt', new Date(0)] },
                          repliedAt,
                        ],
                      },
                      '$$previous.repliedAt',
                      repliedAt,
                    ],
                  },
                },
                in: {
                  $slice: [
                    {
                      $concatArrays: [
                        {
                          $filter: {
                            input: '$$others',
                            as: 'entry',
                            cond: { $gt: ['$$entry.repliedAt', '$$effectiveDate'] },
                          },
                        },
                        [{ oxyUserId, repliedAt: '$$effectiveDate' }],
                        {
                          $filter: {
                            input: '$$others',
                            as: 'entry',
                            cond: { $lte: ['$$entry.repliedAt', '$$effectiveDate'] },
                          },
                        },
                      ],
                    },
                    POST_RECENT_REPLIER_LIMIT,
                  ],
                },
              },
            },
          },
        },
        createdAt: { $ifNull: ['$createdAt', repliedAt] },
        updatedAt: new Date(),
      },
    },
  ];
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

function isRetryableTransactionError(error: unknown): boolean {
  if (isDuplicateKeyError(error)) return true;
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as {
    code?: unknown;
    hasErrorLabel?: (label: string) => boolean;
  };
  if (
    typeof candidate.hasErrorLabel === 'function' &&
    candidate.hasErrorLabel('TransientTransactionError')
  ) {
    return true;
  }

  // WriteConflict, SnapshotUnavailable and NoSuchTransaction can surface
  // without a retry label depending on the server/driver version.
  return [112, 246, 251].includes(Number(candidate.code));
}

async function authoritativeRecentRepliers(
  postId: string,
  session: ClientSession,
): Promise<RecentReplierEntry[]> {
  const rows = await Post.aggregate<{
    oxyUserId?: unknown;
    repliedAt?: unknown;
  }>([
    {
      $match: {
        parentPostId: postId,
        visibility: PostVisibility.PUBLIC,
        status: 'published',
        oxyUserId: { $type: 'string', $ne: '' },
      },
    },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $group: {
        _id: '$oxyUserId',
        repliedAt: { $first: '$createdAt' },
        replyId: { $first: '$_id' },
      },
    },
    { $sort: { repliedAt: -1, replyId: -1 } },
    { $limit: POST_RECENT_REPLIER_LIMIT },
    {
      $project: {
        _id: 0,
        oxyUserId: '$_id',
        repliedAt: 1,
      },
    },
  ]).session(session);

  return rows.flatMap((row) => {
    const oxyUserId = normalizedId(row.oxyUserId);
    const repliedAt = validDate(row.repliedAt);
    return oxyUserId && repliedAt ? [{ oxyUserId, repliedAt }] : [];
  });
}

async function recomputeProjection(
  postId: string,
  session: ClientSession,
): Promise<void> {
  const repliers = await authoritativeRecentRepliers(postId, session);
  if (repliers.length === 0) {
    await PostRecentReplier.deleteOne({ postId }, { session });
    return;
  }

  const now = new Date();
  await PostRecentReplier.updateOne(
    { postId },
    {
      $set: { repliers, updatedAt: now },
      $setOnInsert: { postId, createdAt: now },
    },
    { upsert: true, session },
  );
}

/**
 * The direct replies this transaction deletes, projected onto the fields the
 * deletion cascade needs. Read BEFORE the delete, because afterwards nothing
 * but the ids would be recoverable and half of a post's side tables name it by
 * its ActivityPub identifiers rather than its id.
 */
const DELETED_CHILD_PROJECTION = {
  _id: 1,
  oxyUserId: 1,
  boostOf: 1,
  parentPostId: 1,
  federation: 1,
  'content.pollId': 1,
  'content.article.articleId': 1,
} as const;

async function repairDeletedPostProjectionInTransaction(
  input: { postId: string; parentPostId: string },
  session: ClientSession,
): Promise<DeletedReplyRow[]> {
  if (input.parentPostId) {
    // The authoritative Post query and projection replacement share one
    // snapshot transaction. A concurrent reply writer touches this same
    // projection document, causing Mongo to order the writes or abort/retry
    // this transaction instead of letting a stale snapshot clobber it.
    await recomputeProjection(input.parentPostId, session);
  }

  const deletedChildren = await Post.find({ parentPostId: input.postId })
    .select(DELETED_CHILD_PROJECTION)
    .session(session)
    .lean<DeletedReplyRow[]>();
  const deletedChildIds = deletedChildren
    .map((child) => normalizedId(child._id))
    .filter(Boolean);

  if (deletedChildIds.length > 0) {
    await Post.deleteMany(
      { _id: { $in: deletedChildIds } },
      { session },
    );
  }

  // A deleted parent can have its own replier projection, and each deleted
  // direct child can also have one if it had replies. Remove every projection
  // belonging to rows deleted by this transaction so hydration cannot expose
  // orphaned avatars.
  await PostRecentReplier.deleteMany(
    { postId: { $in: [input.postId, ...deletedChildIds] } },
    { session },
  );

  return deletedChildren;
}

/**
 * Repair the recent-replier read model after a Post row has already been
 * deleted. Fail-soft by design: projection maintenance must never turn a
 * successful authoritative delete into an API failure.
 *
 * Returns the direct replies this call DELETED, which is not something a
 * projection repair would normally have to say — but it deletes them, and their
 * own likes, bookmarks, notifications and gates are then nobody's to clean
 * unless it reports which rows went. Empty when nothing was deleted, and empty
 * when the repair failed outright: an unreported row is a missed cleanup, while
 * a falsely reported one would send the cascade after a post that still exists.
 */
export async function repairRecentRepliersAfterPostDelete(
  input: DeletedPostProjectionContext,
): Promise<DeletedReplyRow[]> {
  const postId = normalizedId(input.postId);
  const parentPostId = normalizedId(input.parentPostId);
  if (!postId) return [];

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PROJECTION_REPAIR_ATTEMPTS; attempt += 1) {
    const session = await mongoose.startSession().catch((error) => {
      lastError = error;
      return null;
    });
    if (!session) break;

    try {
      let deletedReplies: DeletedReplyRow[] = [];
      await session.withTransaction(
        async () => {
          // Reassigned per attempt: a retried transaction re-reads the
          // children, and the previous attempt's rows were rolled back.
          deletedReplies = await repairDeletedPostProjectionInTransaction(
            { postId, parentPostId },
            session,
          );
        },
        PROJECTION_REPAIR_TRANSACTION_OPTIONS,
      );
      return deletedReplies;
    } catch (error) {
      lastError = error;
      if (
        attempt === MAX_PROJECTION_REPAIR_ATTEMPTS ||
        !isRetryableTransactionError(error)
      ) {
        break;
      }
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }

  logger.warn('[PostRecentReplier] Failed to repair projection after post deletion', {
    postId,
    parentPostId: parentPostId || undefined,
    reason: lastError instanceof Error ? lastError.message : String(lastError),
  });
  return [];
}

export async function recordRecentReplierForPost(reply: RecentReplyLike): Promise<void> {
  const postId = String(reply.parentPostId ?? '').trim();
  const oxyUserId = String(reply.oxyUserId ?? '').trim();
  const status = String(reply.status ?? 'published');
  const visibility = String(reply.visibility ?? PostVisibility.PUBLIC);
  const repliedAt = validDate(reply.createdAt) ?? new Date();

  // Only publicly renderable, published replies can contribute an avatar to a
  // public feed DTO. Draft/private replies must never leak through this index.
  if (
    !postId ||
    !oxyUserId ||
    status !== 'published' ||
    visibility !== PostVisibility.PUBLIC
  ) {
    return;
  }

  const pipeline = buildRecentReplierUpdatePipeline(postId, oxyUserId, repliedAt);
  try {
    await PostRecentReplier.updateOne({ postId }, pipeline, { upsert: true });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      try {
        await PostRecentReplier.updateOne({ postId }, pipeline);
        return;
      } catch (retryError) {
        error = retryError;
      }
    }
    logger.warn('[PostRecentReplier] Failed to update projection', {
      postId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function loadRecentReplierIds(
  postIds: string[],
): Promise<RecentReplierProjection> {
  const perPostRepliers = new Map<string, string[]>();
  const allReplierIds = new Set<string>();
  const uniquePostIds = [...new Set(postIds.map(String).filter(Boolean))];
  if (uniquePostIds.length === 0) {
    return { perPostRepliers, allReplierIds };
  }

  try {
    const rows = await PostRecentReplier.find({ postId: { $in: uniquePostIds } })
      .select({ postId: 1, repliers: 1, _id: 0 })
      .lean<Array<{ postId: string; repliers?: RecentReplierEntry[] }>>();

    for (const row of rows) {
      const ids = [...new Set((row.repliers ?? []).map((entry) => String(entry.oxyUserId)))]
        .filter(Boolean)
        .slice(0, POST_RECENT_REPLIER_LIMIT);
      perPostRepliers.set(String(row.postId), ids);
      for (const id of ids) allReplierIds.add(id);
    }
  } catch (error) {
    logger.warn('[PostRecentReplier] Failed to read projection', {
      postCount: uniquePostIds.length,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return { perPostRepliers, allReplierIds };
}
