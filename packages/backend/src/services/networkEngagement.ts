import { publicPositiveLikeSql, MAX_SOCIAL_ACTORS, MAX_SOCIAL_POSTS } from './socialFeedEvidence';
import { and, eq, inArray, gte, lte } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { likes } from '../db/schema/engagement';
import { posts } from '../db/schema/posts';
import { logger } from '../utils/logger';

/**
 * Per-request aggregation of "social proof" — how many people in the VIEWER'S
 * network (following ∪ mutuals) engaged (liked or boosted) each candidate post.
 * Powers the opt-in `socialProof` ranking signal.
 *
 * Bounded + fail-soft by construction: the post-id and engager-id inputs are
 * capped before the `$in` queries so the index scans stay predictable, and ANY
 * error yields an empty map (the signal then stays neutral). A distinct-engager
 * COUNT is returned (a person who both liked and boosted a post counts once).
 */

/** Cap on how many candidate posts we aggregate engagement for in one request. */
const MAX_POSTS = MAX_SOCIAL_POSTS;

/** Cap on the `$in` width of the engager-id set (following ∪ mutuals). */
const MAX_ENGAGERS = MAX_SOCIAL_ACTORS;

export async function getNetworkEngagerCounts(
  postIds: string[],
  engagerIds: string[],
  window?: { since: Date; asOf: Date },
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (postIds.length === 0 || engagerIds.length === 0) {
    return counts;
  }

  const boundedPostIds = postIds.slice(0, MAX_POSTS);
  const boundedEngagers = engagerIds.slice(0, MAX_ENGAGERS);

  // Distinct engagers per post — a Set collapses a like + boost by the same
  // person into a single engager.
  const engagersByPost = new Map<string, Set<string>>();
  const add = (postId: string, userId: string): void => {
    if (!postId || !userId) return;
    let set = engagersByPost.get(postId);
    if (!set) {
      set = new Set<string>();
      engagersByPost.set(postId, set);
    }
    set.add(userId);
  };

  try {
    // Postgres `likes`, where the engagement command service writes.
    //
    // No id-shape filter: `posts.id` is `text` holding ObjectId hex AND uuid v7,
    // so an ObjectId-only filter would discard every uuid-keyed post before the
    // query even ran. Ids are bound parameters here, so no shape check is owed.
    const likeRows = await getDb()
      .select({ postId: likes.postId, userId: likes.userId })
      .from(likes)
      .where(
        and(
          inArray(likes.postId, boundedPostIds),
          inArray(likes.userId, boundedEngagers),
          publicPositiveLikeSql(),
          window ? gte(likes.createdAt, window.since) : undefined,
          window ? lte(likes.createdAt, window.asOf) : undefined,
        ),
      );
    for (const like of likeRows) {
      add(like.postId, like.userId);
    }

    // Boosts are native `type:'boost'` posts referencing the original via `boostOf`.
    const boosts = await getDb()
      .select({ boostOf: posts.boostOf, oxyUserId: posts.oxyUserId })
      .from(posts)
      .where(
        and(
          eq(posts.type, 'boost'),
          eq(posts.status, 'published'),
          eq(posts.visibility, 'public'),
          window ? gte(posts.createdAt, window.since) : undefined,
          window ? lte(posts.createdAt, window.asOf) : undefined,
          inArray(posts.boostOf, boundedPostIds),
          inArray(posts.oxyUserId, boundedEngagers),
        ),
      );
    for (const boost of boosts) {
      if (boost.boostOf && boost.oxyUserId) {
        add(boost.boostOf, boost.oxyUserId);
      }
    }
  } catch (error) {
    logger.warn('[NetworkEngagement] Failed to resolve network engager counts', error);
    return new Map();
  }

  for (const [postId, engagers] of engagersByPost) {
    counts.set(postId, engagers.size);
  }
  return counts;
}
