import { and, eq, inArray } from 'drizzle-orm';
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
const MAX_POSTS = 200;

/** Cap on the `$in` width of the engager-id set (following ∪ mutuals). */
const MAX_ENGAGERS = 500;

export async function getNetworkEngagerCounts(
  postIds: string[],
  engagerIds: string[],
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
    // Postgres, not the Mongo `Like` collection. Nothing has written a Mongo
    // like since the engagement command service moved to Postgres, so this read
    // answered from a store that had stopped moving — plausibly, and never
    // erroring, which is why it could sit here unnoticed while the boost half
    // below already queried Postgres.
    //
    // The `isValidObjectId` filter that used to narrow these ids went with it,
    // and was a second, independent way to lose the same rows: `posts.id` is
    // `text` holding pre-cutover ObjectId hex AND post-cutover uuid v7, so it
    // discarded every post this instance has minted since the cutover before the
    // query even ran. Ids are bound parameters here, so no shape check is owed.
    const likeRows = await getDb()
      .select({ postId: likes.postId, userId: likes.userId })
      .from(likes)
      .where(and(
        inArray(likes.postId, boundedPostIds),
        inArray(likes.userId, boundedEngagers),
      ));
    for (const like of likeRows) {
      add(like.postId, like.userId);
    }

    // Boosts are native `type:'boost'` posts referencing the original via `boostOf`.
    const boosts = await getDb()
      .select({ boostOf: posts.boostOf, oxyUserId: posts.oxyUserId })
      .from(posts)
      .where(and(
        eq(posts.type, 'boost'),
        inArray(posts.boostOf, boundedPostIds),
        inArray(posts.oxyUserId, boundedEngagers),
      ));
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
