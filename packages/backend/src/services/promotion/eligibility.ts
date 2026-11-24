/**
 * Whether a post may be promoted (the paid "Boost"), and if not, why.
 *
 * Pure: the caller supplies the facts it already loaded, so every rule is one
 * line a test can hold. The rules follow what a paid distribution must never
 * be able to buy:
 *  - only the author's OWN, ORIGINAL, public post (not a repost, a quote or a
 *    reply: promoting those would spend money on someone else's words);
 *  - nothing the feed itself keeps out of discovery (sensitive, NSFW, or
 *    behind a content warning) — payment does not widen a gate;
 *  - nothing from an account that keeps its posts inside an audience;
 *  - no account under the protected age profile, which never sees ranked feeds
 *    and so is never a buyer either (oxy ADR 0068);
 *  - one open promotion per post.
 */

import { PostType, PostVisibility } from '@mention/shared-types';
import { type FeedSafetyPostShape, requiresContentWarning } from '../../mtn/feed/feedSafety';

/** The reasons a post cannot be promoted. Stable strings: clients map them to copy. */
export type PromotionIneligibility =
  | 'not-owner'
  | 'not-original'
  | 'not-public'
  | 'not-published'
  | 'content-restricted'
  | 'audience-closed'
  | 'buyer-protected'
  | 'already-promoted';

/** The fields of a post the rules read. */
export interface PromotablePost extends FeedSafetyPostShape {
  oxyUserId: string;
  type: string;
  isReply?: boolean | null;
  visibility: string;
  status: string;
  quoteOf?: string | null;
  boostOf?: string | null;
}

/** Facts about the buyer and the world that are not on the post. */
export interface PromotionContext {
  buyerOxyUserId: string;
  /** The buyer's feed profile is `protected` (a minor). */
  buyerIsProtected: boolean;
  /** The author keeps posts inside their audience (non-public profile). */
  authorAudienceClosed: boolean;
  /** The post already has a pending, active or paused promotion. */
  hasOpenPromotion: boolean;
}

/** Every rule the post breaks, in a stable order; empty means it may be promoted. */
export function promotionIneligibility(
  post: PromotablePost,
  context: PromotionContext,
): PromotionIneligibility[] {
  const reasons: PromotionIneligibility[] = [];
  if (post.oxyUserId !== context.buyerOxyUserId) reasons.push('not-owner');
  if (
    post.type === PostType.REPOST ||
    post.type === PostType.QUOTE ||
    post.isReply ||
    post.quoteOf ||
    post.boostOf
  ) {
    reasons.push('not-original');
  }
  if (post.visibility !== PostVisibility.PUBLIC) reasons.push('not-public');
  if (post.status !== 'published') reasons.push('not-published');
  if (requiresContentWarning(post)) reasons.push('content-restricted');
  if (context.authorAudienceClosed) reasons.push('audience-closed');
  if (context.buyerIsProtected) reasons.push('buyer-protected');
  if (context.hasOpenPromotion) reasons.push('already-promoted');
  return reasons;
}
