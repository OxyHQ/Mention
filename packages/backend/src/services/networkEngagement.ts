import mongoose from 'mongoose';
import Like from '../models/Like';
import { Post } from '../models/Post';
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
  const objectIds = boundedPostIds
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

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
    if (objectIds.length > 0) {
      const likes = await Like.find({
        postId: { $in: objectIds },
        userId: { $in: boundedEngagers },
      })
        .select('postId userId')
        .lean();
      for (const like of likes) {
        add(String(like.postId), String(like.userId));
      }
    }

    // Boosts are native `type:'boost'` posts referencing the original via `boostOf`.
    const boosts = await Post.find({
      type: 'boost',
      boostOf: { $in: boundedPostIds },
      oxyUserId: { $in: boundedEngagers },
    })
      .select('boostOf oxyUserId')
      .lean();
    for (const boost of boosts) {
      if (boost.boostOf && boost.oxyUserId) {
        add(String(boost.boostOf), String(boost.oxyUserId));
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
