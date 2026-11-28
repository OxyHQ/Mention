// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
 *  - nothing about politics, gambling and casinos or animal sales, which Oxy does not sell reach for
 *    (see contentExclusions.ts), and nothing whose classification has not run yet, since a post that
 *    cannot be judged is refused rather than guessed;
 *  - one open promotion per post.
 */

import { PostType, PostVisibility, isRepostType } from '@mention/shared-types';
import { type FeedSafetyPostShape, requiresContentWarning } from '../../../mtn/feed/feedSafety';
import { type ExcludedCategory, excludedCategory } from './contentExclusions';

/** The reasons a post cannot be promoted. Stable strings: clients map them to copy. */
export type PromotionIneligibility =
  | 'not-owner'
  | 'not-original'
  | 'not-public'
  | 'not-published'
  | 'content-restricted'
  | 'category-excluded'
  | 'not-classified'
  | 'audience-closed'
  | 'buyer-protected'
  | 'already-promoted';

/** The fields of a post the rules read. */
export interface PromotablePost extends FeedSafetyPostShape {
  /** Nullable on a raw federated insert; an absent author is nobody's own post. */
  oxyUserId: string | null;
  type: string;
  isReply?: boolean | null;
  visibility: string;
  status: string;
  quoteOf?: string | null;
  boostOf?: string | null;
  /** The Stage-A/B classification: its status and topics. */
  classification?: { status?: string; topics?: string[]; hashtagsNorm?: string[] } | null;
  /** The language renditions of the body. */
  content?: { variants?: ReadonlyArray<{ text?: string | null }> } | null;
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
    isRepostType(post.type) ||
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
  if (post.classification?.status === 'pending') reasons.push('not-classified');
  if (excludedPostCategory(post) !== null) reasons.push('category-excluded');
  if (context.authorAudienceClosed) reasons.push('audience-closed');
  if (context.buyerIsProtected) reasons.push('buyer-protected');
  if (context.hasOpenPromotion) reasons.push('already-promoted');
  return reasons;
}

/** The category a promotable post is refused for, if any. */
export function excludedPostCategory(post: PromotablePost): ExcludedCategory | null {
  return excludedCategory({
    topics: post.classification?.topics,
    hashtags: [...(post.hashtags ?? []), ...(post.classification?.hashtagsNorm ?? [])],
    texts: (post.content?.variants ?? []).map((variant) => variant.text ?? ''),
  });
}
