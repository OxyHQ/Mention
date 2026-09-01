/**
 * The three statements every cascade leg goes through.
 *
 * One chokepoint for "count it or delete it", so a dry run is read-only by
 * construction rather than by every leg remembering to be — and one place the
 * post `DELETE` that all eighteen database-performed manifest entries hang off
 * is written down.
 */

import { count, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import type { PostBatch } from './channelDeletionTargets';

/** How many rows match, without touching them. */
export async function countRows(table: PgTable, where: SQL): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(table).where(where);
  return row.n;
}

/**
 * Count (dry run) or delete (live), returning the affected-row count either way.
 * The single chokepoint that keeps a dry run strictly read-only — mirrors
 * `scripts/purgeGoneFederatedActors.ts`.
 */
export async function countOrDelete(table: PgTable, where: SQL, dryRun: boolean): Promise<number> {
  if (dryRun) return countRows(table, where);
  const removed = await getDb().delete(table).where(where).returning({ deleted: sql<number>`1` });
  return removed.length;
}

/**
 * Delete one batch of the channel's posts — the statement every `ON DELETE`
 * constraint in the manifest hangs off.
 *
 * By the captured id set rather than by owner, so it removes exactly what the
 * preflight cleared and the dependent legs were enumerated from: a post created
 * since the batch was read is left for the next iteration rather than deleted
 * with its dependents unswept.
 */
export async function deleteBatchPosts(batch: PostBatch, dryRun: boolean): Promise<number> {
  const ids = batch.channelPosts.map((row) => row.id);
  if (dryRun) return ids.length;
  const removed = await getDb()
    .delete(posts)
    .where(inArray(posts.id, ids))
    .returning({ id: posts.id });
  return removed.length;
}
