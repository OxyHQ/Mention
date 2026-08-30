/**
 * COUNTERS ON POSTS THAT SURVIVE the run but lose an engagement record to it.
 *
 * Deliberately outside the manifest accounting: no manifest entry describes a
 * counter, and inventing a step key for one would break the set equality that
 * binds the executor to the manifest.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { likes } from '../../db/schema/engagement';
import { logger } from '../../utils/logger';
import { LOG_PREFIX } from './channelCascadeLog';
import { countRows } from './channelCascadeQueries';

/**
 * The posts the channel LIKED, read while its `likes` rows still exist.
 *
 * Ordering is load-bearing and is why this is its own function rather than a read
 * inside the repair: the account phase deletes `likes.user_id = <channel>`, so a
 * repair that discovered these afterwards would find nothing and silently leave
 * every one of those counters an increment too high. Called before that phase,
 * used after it.
 */
export async function readLikedPostIds(channelOxyUserId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ postId: likes.postId })
    .from(likes)
    .where(eq(likes.userId, channelOxyUserId));
  return rows.map((row) => row.postId);
}

/**
 * Repair the denormalized counters on posts that SURVIVE this run but lose an
 * engagement record to it.
 *
 * TWO cases, and the ones that are NOT here are structural rather than omissions:
 *
 *  - A channel post that BOOSTED somebody else's surviving post. Its own boosts
 *    are inside the removed set by construction (the closure is seeded from it),
 *    so only an original OUTSIDE the set can need repairing.
 *  - A `Like` the channel left on somebody else's surviving post.
 *  - NOT `stats_comments_count`: a channel post is never a reply to somebody else
 *    (the reply gate refuses a `channel` author at five sites) and a channel
 *    thread's continuations answer the channel's own posts, which are inside the
 *    removed set.
 *  - NOT `stats_federated_boosts_count`: it counts inbound Announces, and a
 *    channel is a local author.
 *
 * Each decrement is guarded on `> 0`, mirroring the live `Undo(Announce)` /
 * unlike teardown, so a counter that already lags cannot underflow. Deleted posts
 * drop out on their own — an id no longer in `posts` matches nothing.
 */
export async function repairSurvivingCounters(
  boostedOriginalIds: readonly string[],
  likedPostIds: readonly string[],
  dryRun: boolean,
): Promise<{ boostCounters: number; likeCounters: number }> {
  return {
    boostCounters: await decrementStat(boostedOriginalIds, 'boosts', dryRun),
    likeCounters: await decrementStat(likedPostIds, 'likes', dryRun),
  };
}

/**
 * One guarded bulk decrement. A failure is LOGGED and swallowed rather than
 * thrown, which is the opposite of every other step here and deliberate: the ids
 * being repaired were derived from rows this run has already deleted, so a retry
 * computes an EMPTY repair set and can never make good on it. Failing the job
 * would therefore lose the deletion's success without saving the counter. A stale
 * denormalized count is reconcilable on its own
 * (`scripts/recomputeFederatedEngagement.ts`); a half-reported cascade is not.
 *
 * The two counters are named by a literal union rather than passed as a
 * `PgColumn`, because `.set()` is keyed by the drizzle PROPERTY name and building
 * that key dynamically would need a cast the compiler could not check — the exact
 * shape that lets a typo write to a column nobody meant.
 */
async function decrementStat(
  postIds: readonly string[],
  stat: 'boosts' | 'likes',
  dryRun: boolean,
): Promise<number> {
  if (postIds.length === 0) return 0;
  const column = stat === 'boosts' ? posts.statsBoostsCount : posts.statsLikesCount;
  const where = and(inArray(posts.id, [...postIds]), sql`${column} > 0`);
  if (where === undefined) return 0;
  try {
    // The dry-run figure counts the SAME predicate the live write uses, so it is
    // not an optimistic guess about a post that may no longer exist.
    if (dryRun) return countRows(posts, where);
    const updated = await getDb()
      .update(posts)
      .set(
        stat === 'boosts'
          ? { statsBoostsCount: sql`${posts.statsBoostsCount} - 1` }
          : { statsLikesCount: sql`${posts.statsLikesCount} - 1` },
      )
      .where(where)
      .returning({ id: posts.id });
    return updated.length;
  } catch (error) {
    logger.error(`${LOG_PREFIX} could not repair a counter on a surviving post`, { stat, error });
    return 0;
  }
}
