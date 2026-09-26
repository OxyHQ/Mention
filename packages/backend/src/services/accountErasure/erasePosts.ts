/**
 * THE POST WALK: every post the erased account owns, destroyed in keyset batches.
 *
 * This performs the `posts.oxyUserId` entry of the erasure map. It follows the
 * channel cascade's batch design (`services/channelDeletion`) and reuses the same
 * pieces: `PostDeletionCascade.cascadePostReferences` for the references no
 * foreign key can express, `assertPostsSafeToDelete` before and the residue probes
 * after. It differs in three ways, each because a person is not a channel:
 *
 *  1. OTHER PEOPLE'S REPLIES STAY. The live single-post delete removes a post's
 *     direct replies; erasing a person must not destroy what other people wrote.
 *     `parent_post_id` is `ON DELETE SET NULL` and the stored `is_reply` stays
 *     true, so an orphaned reply never becomes a root post in any feed (every root
 *     feed filters on `is_reply`). Quotes stay the same way (`quote_of` → NULL).
 *     Boosts of the account's posts go (`boost_of` cascades): a boost is an empty
 *     card that renders only its original.
 *  2. COUNTERS on surviving posts are repaired INSIDE the batch transaction: a
 *     reply the account left takes one off its parent's `stats_comments_count`, a
 *     boost takes one off its original's `stats_boosts_count`. Inside, not after,
 *     so a crash can never apply a decrement twice or lose one.
 *  3. A HUGE boost closure is not refused. A popular post can have more boosts
 *     than one statement should carry; those are deleted deepest-first in bounded
 *     chunks, each in its own transaction, before the batch that owns them.
 *
 * Every step is idempotent. A re-run after a crash re-reads what survived and
 * walks from the start; a batch either committed whole or not at all.
 */

import { and, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { qualified } from '@oxy.so/db';
import { getDb, type Transaction } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { postAuthorships } from '../../db/schema/postContent';
import { moderationEnforcements } from '../../db/schema/moderation';
import { repairFetchFailures } from '../../db/schema/adminScripts';
import { postgates } from '../../db/schema/gates';
import { findClusterIdsForPosts } from '../../db/posts/postEquivalenceRepository';
import {
  assertPostsSafeToDelete,
  collectPostCascadeResidue,
  type PostDeletionTarget,
} from '../../scripts/lib/adminDeletionPreflight';
import {
  CASCADED_POST_REFERENCES,
  POST_REFERENCES_KEPT_BY_POLICY,
  POST_REFERENCES_REMOVED_BY_DATABASE,
  cascadePostReferences,
  type CascadedPostRow,
} from '../PostDeletionCascade';
import { reevaluateClusters } from '../PostEquivalenceService';
import { recomputeRecentRepliers } from '../PostRecentReplierService';
import { invalidate as invalidatePostDetail } from '../postDetailCache';
import { logger } from '../../utils/logger';
import { ERASURE_BOOST_CHUNK, ERASURE_POST_BATCH } from './erasureLimits';


const LOG_PREFIX = '[AccountErasure]';

const CASCADE_ROW = {
  id: posts.id,
  oxyUserId: posts.oxyUserId,
  parentPostId: posts.parentPostId,
  federationActivityId: posts.federationActivityId,
  federationUrl: posts.federationUrl,
} as const;

const OWN_ROW = {
  ...CASCADE_ROW,
  type: posts.type,
  visibility: posts.visibility,
  status: posts.status,
  boostOf: posts.boostOf,
  federationActorUri: posts.federationActorUri,
} as const;

export interface OwnPostRow extends CascadedPostRow {
  type: string;
  visibility: string;
  status: string;
  boostOf: string | null;
  parentPostId: string | null;
  federationActorUri: string | null;
}

/** A post is the account's by the owner cache OR by its authorship owner entry. */
export function ownedBy(oxyUserId: string): SQL {
  const byAuthorship = sql`exists (select 1 from ${postAuthorships} where ${qualified(postAuthorships.postId)} = ${qualified(posts.id)} and ${qualified(postAuthorships.oxyUserId)} = ${oxyUserId} and ${qualified(postAuthorships.role)} = 'owner')`;
  return sql`(${eq(posts.oxyUserId, oxyUserId)} or ${byAuthorship})`;
}

function postUris(row: CascadedPostRow): string[] {
  return [row.federationActivityId, row.federationUrl].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

function targetsOf(rows: readonly CascadedPostRow[]): PostDeletionTarget[] {
  return rows.map((row) => ({ id: row.id, uris: postUris(row) }));
}

/**
 * Was this post ever advertised to the fediverse? Only a LOCAL, PUBLIC,
 * PUBLISHED post was; a Delete for anything else names an object no remote
 * server has heard of.
 */
export function wasFederated(post: OwnPostRow): boolean {
  return (
    post.federationActorUri === null &&
    post.visibility === PostVisibility.PUBLIC &&
    post.status === 'published'
  );
}

/**
 * The boosts that die with `seedIds`, by level: level 0 boosts a seed, level 1
 * boosts a level-0 boost, and so on. Captured while the `boost_of` links are live.
 */
async function boostLevels(seedIds: readonly string[]): Promise<CascadedPostRow[][]> {
  const db = getDb();
  const seen = new Set(seedIds);
  const levels: CascadedPostRow[][] = [];
  let frontier = [...seedIds];
  while (frontier.length > 0) {
    const next: CascadedPostRow[] = [];
    for (let start = 0; start < frontier.length; start += ERASURE_BOOST_CHUNK) {
      const slice = frontier.slice(start, start + ERASURE_BOOST_CHUNK);
      const rows = await db.select(CASCADE_ROW).from(posts).where(inArray(posts.boostOf, slice));
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        next.push(row);
      }
    }
    if (next.length === 0) break;
    levels.push(next);
    frontier = next.map((row) => row.id);
  }
  return levels;
}

/**
 * Delete one chunk of other people's boosts with their polymorphic references, in
 * one transaction. Called deepest level first, so no chunk's delete cascades into
 * a boost whose references have not been swept.
 */
async function deleteBoostChunk(rows: readonly CascadedPostRow[]): Promise<number> {
  const ids = rows.map((row) => row.id);
  let removed = 0;
  await getDb().transaction(async (tx) => {
    await cascadePostReferences(rows, tx);
    await deleteModerationAndRepairRows(tx, ids);
    const deleted = await tx.delete(posts).where(inArray(posts.id, ids)).returning({ id: posts.id });
    removed = deleted.length;
  });
  for (const id of ids) await invalidatePostDetail(id);
  return removed;
}

/** Post-scoped rows no foreign key reaches: enforcement records and repair evidence. */
async function deleteModerationAndRepairRows(tx: Transaction, ids: readonly string[]): Promise<void> {
  await tx
    .delete(moderationEnforcements)
    .where(and(eq(moderationEnforcements.subjectType, 'post'), inArray(moderationEnforcements.subjectId, [...ids])));
  await tx.delete(repairFetchFailures).where(inArray(repairFetchFailures.postId, [...ids]));
}

/** Somebody else's postgate listing a doomed post among its detached quotes. */
async function pullDetachedQuoteUris(tx: Transaction, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await tx
    .update(postgates)
    .set({
      detachedQuoteUris: sql`(select coalesce(array_agg(elem), '{}'::text[]) from unnest(${qualified(postgates.detachedQuoteUris)}) as elem where elem <> all(${sql.param([...keys])}::text[]))`,
    })
    .where(sql`${postgates.detachedQuoteUris} && ${sql.param([...keys])}::text[]`);
}

/** Take `counts` (post id → n) off one counter column, never below zero. */
async function decrement(
  tx: Transaction,
  column: 'stats_comments_count' | 'stats_boosts_count',
  counts: ReadonlyMap<string, number>,
): Promise<void> {
  if (counts.size === 0) return;
  const ids = [...counts.keys()];
  const amounts = ids.map((id) => counts.get(id) ?? 0);
  await tx.execute(sql`
    update ${posts} set ${sql.identifier(column)} = greatest(0, ${posts}.${sql.identifier(column)} - d.n)
    from (select unnest(${sql.param(ids)}::text[]) as id, unnest(${sql.param(amounts)}::int[]) as n) as d
    where ${posts}.id = d.id
  `);
}

function tally(values: readonly (string | null)[], removed: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value === null || removed.has(value)) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** Called with each batch's federated posts BEFORE the batch is deleted. */
export type BroadcastPostDeletes = (posts: readonly OwnPostRow[]) => Promise<number>;

export interface ErasePostsResult {
  /** The account's own posts deleted. */
  posts: number;
  /** Other people's boosts of them, deleted with them. */
  boostsByOthers: number;
  /** `Delete(Note)` activities handed to delivery. */
  deletesSent: number;
}

/**
 * Walk and destroy every post `oxyUserId` owns. `broadcast` is called per batch
 * with the posts that were federated, before they are deleted (a remote server
 * must be told while the ids still mean something locally; a Delete is
 * idempotent remotely, so a retry re-sending one is harmless).
 */
export async function eraseAccountPosts(
  oxyUserId: string,
  broadcast: BroadcastPostDeletes | null,
): Promise<ErasePostsResult> {
  const db = getDb();
  const result: ErasePostsResult = { posts: 0, boostsByOthers: 0, deletesSent: 0 };
  let after: string | null = null;

  for (;;) {
    const own: OwnPostRow[] = await db
      .select(OWN_ROW)
      .from(posts)
      .where(after === null ? ownedBy(oxyUserId) : and(ownedBy(oxyUserId), gt(posts.id, after)))
      .orderBy(posts.id)
      .limit(ERASURE_POST_BATCH);
    if (own.length === 0) break;
    after = own[own.length - 1].id;

    const ownIds = own.map((row) => row.id);
    const levels = await boostLevels(ownIds);
    const boostCount = levels.reduce((sum, level) => sum + level.length, 0);

    // A large closure is cleared first, deepest level first, in bounded chunks.
    let boosts: CascadedPostRow[] = levels.flat();
    if (boostCount > ERASURE_BOOST_CHUNK) {
      for (const level of [...levels].reverse()) {
        for (let start = 0; start < level.length; start += ERASURE_BOOST_CHUNK) {
          result.boostsByOthers += await deleteBoostChunk(level.slice(start, start + ERASURE_BOOST_CHUNK));
        }
      }
      boosts = [];
    }

    const rows: CascadedPostRow[] = [...own, ...boosts];
    const allIds = rows.map((row) => row.id);
    const removed = new Set(allIds);

    // Prove nothing unacknowledged is stranded, before telling anyone anything.
    await assertPostsSafeToDelete(`accountErasure:${oxyUserId}`, targetsOf(rows), {
      removedByCascade: [...CASCADED_POST_REFERENCES, ...POST_REFERENCES_REMOVED_BY_DATABASE],
      keptByPolicy: POST_REFERENCES_KEPT_BY_POLICY,
      allowDanglingReplyReferences: true,
    });

    const federated = own.filter(wasFederated);
    if (broadcast && federated.length > 0) {
      result.deletesSent += await broadcast(federated);
    }

    const survivingParents = tally(own.map((row) => row.parentPostId), removed);
    const boostedOriginals = tally(
      own.filter((row) => row.type === PostType.BOOST).map((row) => row.boostOf),
      removed,
    );

    let clusterIds: string[] = [];
    await db.transaction(async (tx) => {
      clusterIds = await findClusterIdsForPosts(allIds, tx);
      await cascadePostReferences(rows, tx);
      await deleteModerationAndRepairRows(tx, allIds);
      await pullDetachedQuoteUris(tx, [...new Set(rows.flatMap((row) => [row.id, ...postUris(row)]))]);
      await decrement(tx, 'stats_comments_count', survivingParents);
      await decrement(tx, 'stats_boosts_count', boostedOriginals);
      // Boosts first by id, then the account's posts; `boost_of` would cascade
      // them anyway, but naming them keeps the count honest.
      if (boosts.length > 0) {
        const gone = await tx
          .delete(posts)
          .where(inArray(posts.id, boosts.map((row) => row.id)))
          .returning({ id: posts.id });
        result.boostsByOthers += gone.length;
      }
      const deleted = await tx.delete(posts).where(inArray(posts.id, ownIds)).returning({ id: posts.id });
      result.posts += deleted.length;
    });

    // Best-effort work after the commit. Each is recomputed from authoritative
    // rows, so a failure here is repaired by the next run or by reconciliation.
    if (clusterIds.length > 0) await reevaluateClusters(clusterIds);
    for (const parentId of survivingParents.keys()) {
      try {
        await db.transaction((tx) => recomputeRecentRepliers(parentId, tx).then(() => undefined));
      } catch (error) {
        logger.warn(`${LOG_PREFIX} could not recompute a reply strip`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const id of allIds) await invalidatePostDetail(id);

    const residue = await collectPostCascadeResidue(targetsOf(rows), [
      ...CASCADED_POST_REFERENCES,
      ...POST_REFERENCES_REMOVED_BY_DATABASE,
    ]);
    if (residue.length > 0) {
      logger.error(`${LOG_PREFIX} a batch left references it claimed to remove`, { residue });
    }
  }

  return result;
}

/** How many posts the walk would take, and how many federated. Read-only. */
export async function countAccountPosts(oxyUserId: string): Promise<{ posts: number; federated: number }> {
  const [row] = await getDb()
    .select({
      posts: sql<number>`count(*)::int`,
      federated: sql<number>`count(*) filter (where ${posts.federationActorUri} is null and ${posts.visibility} = ${PostVisibility.PUBLIC} and ${posts.status} = 'published')::int`,
    })
    .from(posts)
    .where(ownedBy(oxyUserId));
  return { posts: row?.posts ?? 0, federated: row?.federated ?? 0 };
}
