/**
 * The recent-replier read model: the ≤3 newest DISTINCT public repliers per post,
 * newest first, used to render reply avatars on a feed card.
 *
 * ## `buildRecentReplierUpdatePipeline` is gone, and nothing replaces it
 *
 * Mongo kept one document per post holding an ORDERED array with a `≤3`
 * validator, and maintaining it needed a hand-written aggregation update
 * pipeline — a `$let` over `$filter`/`$concatArrays`/`$slice` that spliced the
 * candidate into the array in place while preserving a NEWER existing entry from
 * the same user. That pipeline existed only because an array cannot be updated
 * any other way; with one ROW per (post, replier) there is nothing to splice.
 * `mergeRecentRepliers`, the pure reference implementation that existed to make
 * the pipeline testable in isolation, is gone with it — the behaviour it modelled
 * is now asserted against real rows.
 *
 * The three rules it encoded all survive, as SQL:
 *
 * - **Newest wins per user** — `greatest(excluded.replied_at, …)` in the upsert,
 *   so historical federation/backfill arriving out of order cannot demote a
 *   newer reply.
 * - **Distinct per user** — the `(post_id, oxy_user_id)` unique constraint.
 * - **Capped at three** — a bounded delete after the upsert. A CHECK cannot
 *   count sibling rows, so the cap stays the writer's job.
 *
 * ## Fail-soft, everywhere
 *
 * This is a projection. A write failure must never turn a successful reply (or a
 * successful post deletion) into an API failure, so every entry point here logs
 * and resolves rather than throwing.
 */

import { and, desc, eq, inArray, isNotNull, ne, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { PostVisibility } from '@mention/shared-types';
import { getDb, type Transaction } from '../db/postgres';
import {
  DEADLOCK_DETECTED,
  SERIALIZATION_FAILURE,
  isUniqueViolation,
  sqlStateOf,
} from '@oxyhq/db';
import { POST_RECENT_REPLIER_LIMIT, postRecentRepliers } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import { logger } from '../utils/logger';

/** Attempts before a projection repair gives up and logs. */
const MAX_PROJECTION_REPAIR_ATTEMPTS = 3;

/** One row of the projection, in the order the read model returns it. */
export interface RecentReplierEntry {
  oxyUserId: string;
  repliedAt: Date;
}

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

function validDate(value: unknown): Date | null {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizedId(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Only publicly renderable, published replies by a known author can contribute
 * an avatar to a public feed DTO. Exported so the reconciliation sweep selects
 * exactly the same candidates this projection is built from — two copies of this
 * predicate is how a repair starts disagreeing with the thing it repairs.
 *
 * The two literals are checked against the column's own value tuples
 * (`POST_VISIBILITIES` / `POST_STATUSES`), so a typo fails `tsc` rather than
 * silently matching nothing.
 */
export const ELIGIBLE_REPLY_MATCH = and(
  eq(posts.visibility, 'public'),
  eq(posts.status, 'published'),
  isNotNull(posts.oxyUserId),
  ne(posts.oxyUserId, ''),
);

/**
 * The authoritative ≤3, recomputed from the replies themselves.
 *
 * Two stages rather than one: `DISTINCT ON (oxy_user_id)` collapses each author
 * to their newest eligible reply, and the outer query then ranks those winners
 * and takes three. Doing it in one pass would rank replies rather than authors
 * and could return the same person three times.
 */
async function authoritativeRecentRepliers(
  postId: string,
  tx: Transaction,
): Promise<RecentReplierEntry[]> {
  const newestPerAuthor = tx
    .selectDistinctOn([posts.oxyUserId], {
      oxyUserId: posts.oxyUserId,
      repliedAt: posts.createdAt,
      replyId: posts.id,
    })
    .from(posts)
    .where(and(eq(posts.parentPostId, postId), ELIGIBLE_REPLY_MATCH))
    .orderBy(posts.oxyUserId, desc(posts.createdAt), desc(posts.id))
    .as('newest_per_author');

  const rows = await tx
    .select({
      oxyUserId: newestPerAuthor.oxyUserId,
      repliedAt: newestPerAuthor.repliedAt,
    })
    .from(newestPerAuthor)
    .orderBy(desc(newestPerAuthor.repliedAt), desc(newestPerAuthor.replyId))
    .limit(POST_RECENT_REPLIER_LIMIT);

  return rows.flatMap((row) => {
    const oxyUserId = normalizedId(row.oxyUserId);
    return oxyUserId ? [{ oxyUserId, repliedAt: row.repliedAt }] : [];
  });
}

/**
 * Replace one post's projection with the authoritative answer.
 *
 * Exported for `EngagementProjectionReconciliationService`, which repairs posts
 * whose legacy writers never maintained this table. Both callers run it inside a
 * transaction they own, so the read and the replacement share one snapshot and a
 * concurrent reply writer either serializes after it or forces a retry.
 */
export async function recomputeRecentRepliers(
  postId: string,
  tx: Transaction,
): Promise<RecentReplierEntry[]> {
  const repliers = await authoritativeRecentRepliers(postId, tx);
  await tx.delete(postRecentRepliers).where(eq(postRecentRepliers.postId, postId));
  if (repliers.length > 0) {
    await tx.insert(postRecentRepliers).values(
      repliers.map((entry) => ({
        postId,
        oxyUserId: entry.oxyUserId,
        repliedAt: entry.repliedAt,
      })),
    );
  }
  return repliers;
}

/**
 * Trim a post's projection down to the newest `POST_RECENT_REPLIER_LIMIT` rows.
 *
 * The subquery is ALIASED rather than naming the same table twice bare. Both
 * spellings are valid SQL, but the aliased one states which range table each
 * `post_id` belongs to — and a self-referencing predicate whose column
 * resolution is left implicit is exactly the shape that silently returned an
 * empty set in the sibling oxy-api port.
 */
async function trimToLimit(postId: string, tx: Transaction): Promise<void> {
  const survivor = alias(postRecentRepliers, 'survivor');
  const newest = tx
    .select({ id: survivor.id })
    .from(survivor)
    .where(eq(survivor.postId, postId))
    .orderBy(desc(survivor.repliedAt), desc(survivor.id))
    .limit(POST_RECENT_REPLIER_LIMIT);

  await tx
    .delete(postRecentRepliers)
    .where(
      and(
        eq(postRecentRepliers.postId, postId),
        notInArray(postRecentRepliers.id, newest),
      ),
    );
}

/**
 * Record one reply against its parent's projection.
 *
 * The hot path: called from every reply-creation site (native, federated, MTN
 * materialization), fire-and-forget. Two statements in one transaction, because
 * the array splice that used to make this atomic no longer exists — an upsert
 * that keeps the newer timestamp, then the cap.
 */
export async function recordRecentReplierForPost(reply: RecentReplyLike): Promise<void> {
  const postId = normalizedId(reply.parentPostId);
  const oxyUserId = normalizedId(reply.oxyUserId);
  const status = String(reply.status ?? 'published');
  const visibility = String(reply.visibility ?? PostVisibility.PUBLIC);
  const repliedAt = validDate(reply.createdAt) ?? new Date();

  // Draft/private replies must never leak an avatar through this index.
  if (
    !postId ||
    !oxyUserId ||
    status !== 'published' ||
    visibility !== PostVisibility.PUBLIC
  ) {
    return;
  }

  try {
    await getDb().transaction(async (tx) => {
      await tx
        .insert(postRecentRepliers)
        .values({ postId, oxyUserId, repliedAt })
        .onConflictDoUpdate({
          target: [postRecentRepliers.postId, postRecentRepliers.oxyUserId],
          // Backfill and federation import replies out of order, so an older
          // arrival must never demote this author's newest known reply.
          set: {
            repliedAt: sql`greatest(${postRecentRepliers.repliedAt}, excluded.replied_at)`,
            updatedAt: new Date(),
          },
        });
      await trimToLimit(postId, tx);
    });
  } catch (error) {
    logger.warn('[PostRecentReplier] Failed to update projection', {
      postId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Repair the read model after a Post row has already been deleted.
 *
 * ONE job, and it is about the PARENT rather than about the deleted post: the
 * deleted row was one of its repliers, so its avatar row has to go and the next
 * replier behind it has to take the slot. Nothing else here is reachable.
 *
 * **THIS FUNCTION USED TO DO TWO MORE THINGS, AND BOTH WERE DEAD — for the same
 * structural reason, one layer apart.** It ran AFTER a committed deletion, so
 * every row it went looking for was already gone:
 *
 *  - It DELETED THE DIRECT REPLIES by `parent_post_id`. Its own comment
 *    predicted the failure: `posts.parent_post_id` is `ON DELETE SET NULL`, so
 *    the parent's DELETE nulls those links first. Zero rows on `deletePost`
 *    (whose transaction deletes the replies itself and commits before this
 *    runs), zero on the MTN tombstone path — where nothing else deleted them
 *    either, so replies were PROMOTED to root posts. That was bug #126, live on
 *    a second path. `deletePostSubtree` owns the subtree now.
 *  - It DELETED THE PROJECTIONS of the deleted post and its replies.
 *    `post_recent_repliers.post_id` is `ON DELETE CASCADE` on `posts.id`
 *    (MEASURED, not assumed: one projection row before the post's DELETE, zero
 *    after), so the database had already removed every row that statement named.
 *    Its absence is asserted after the fact anyway — `post_recent_repliers.post_id`
 *    is a `database`-disposition probe in `adminDeletionPreflight`, so
 *    `reportResidue` fails if one ever survives.
 *
 * Dead and redundant look identical from outside and mean opposite things: the
 * first was hiding a data-loss bug, the second was merely re-doing the
 * database's work. Neither was reachable, and the only cases that exercised
 * either were tests calling this WITHOUT deleting the post first — a state no
 * production caller can produce.
 */
async function repairDeletedPostProjection(
  input: { parentPostId: string },
  tx: Transaction,
): Promise<void> {
  if (!input.parentPostId) return;
  await recomputeRecentRepliers(input.parentPostId, tx);
}

/**
 * The failures a concurrent writer on this same projection can produce, and
 * which a fresh transaction resolves.
 *
 * `sqlStateOf` walks drizzle's wrapper to the driver error underneath; reading
 * `error.code` directly matches nothing, because drizzle re-wraps and the
 * SQLSTATE lives on `cause`.
 */
function isRetryableProjectionConflict(error: unknown): boolean {
  if (isUniqueViolation(error)) return true;
  const sqlState = sqlStateOf(error);
  return sqlState === SERIALIZATION_FAILURE || sqlState === DEADLOCK_DETECTED;
}

/**
 * Repair the recent-replier read model after a post deletion. Fail-soft by
 * design: projection maintenance must never turn a successful authoritative
 * delete into an API failure.
 */
export async function repairRecentRepliersAfterPostDelete(
  input: DeletedPostProjectionContext,
): Promise<void> {
  const postId = normalizedId(input.postId);
  const parentPostId = normalizedId(input.parentPostId);
  if (!postId) return;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PROJECTION_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      await getDb().transaction(async (tx) => {
        await repairDeletedPostProjection({ parentPostId }, tx);
      });
      return;
    } catch (error) {
      lastError = error;
      if (
        attempt === MAX_PROJECTION_REPAIR_ATTEMPTS ||
        !isRetryableProjectionConflict(error)
      ) {
        break;
      }
    }
  }

  logger.warn('[PostRecentReplier] Failed to repair projection after post deletion', {
    postId,
    parentPostId: parentPostId || undefined,
    reason: lastError instanceof Error ? lastError.message : String(lastError),
  });
}

/**
 * Read the projection for a page of posts.
 *
 * The ORDER is load-bearing — the caller renders these as avatars, newest first —
 * so it is stated in SQL rather than inherited from the storage order an array
 * used to provide.
 */
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
    const rows = await getDb()
      .select({
        postId: postRecentRepliers.postId,
        oxyUserId: postRecentRepliers.oxyUserId,
      })
      .from(postRecentRepliers)
      // `inArray`, never `= any(${jsArray})`: a raw JS array interpolated into a
      // `sql` template binds as a ROW constructor and Postgres rejects it.
      .where(inArray(postRecentRepliers.postId, uniquePostIds))
      .orderBy(
        postRecentRepliers.postId,
        desc(postRecentRepliers.repliedAt),
        desc(postRecentRepliers.id),
      );

    for (const row of rows) {
      const existing = perPostRepliers.get(row.postId) ?? [];
      // The writer caps at the limit, but a row written before this projection
      // existed — or by a concurrent trim — must not widen the page's avatar row.
      if (existing.length >= POST_RECENT_REPLIER_LIMIT) continue;
      // No de-duplication pass: `post_recent_repliers_post_id_oxy_user_id_key`
      // makes a repeated author for one post unrepresentable, where the Mongo
      // array could hold one.
      existing.push(row.oxyUserId);
      perPostRepliers.set(row.postId, existing);
      allReplierIds.add(row.oxyUserId);
    }
  } catch (error) {
    logger.warn('[PostRecentReplier] Failed to read projection', {
      postCount: uniquePostIds.length,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return { perPostRepliers, allReplierIds };
}
