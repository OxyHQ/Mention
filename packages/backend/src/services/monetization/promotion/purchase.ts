// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * Starting the purchase of a promotion: everything up to payment.
 *
 * What this does is decide whether the post may be promoted and, if so, record a
 * `pending_payment` purchase of the tier the person picked. It takes no money and
 * activates nothing; a promotion becomes `active` only when the payment
 * integration confirms a paid invoice (docs/boost.md), so until that exists no
 * purchase can ever start delivering.
 */

import { MtnConfig } from '@mention/shared-types';
import {
  createPendingPromotion,
  findOpenPromotionForPost,
  type PostPromotionRow,
  promotionTier,
} from '../../../db/promotions/promotionRepository';
import { loadPostRecords } from '../../../db/posts/postRepository';
import { accountsWithClosedAudience } from '../../../db/userProfile/profileAudience';
import { type PromotionIneligibility, promotionIneligibility } from './eligibility';

export type PromotionPurchaseResult =
  | { ok: true; promotion: PostPromotionRow }
  | { ok: false; reason: 'disabled' | 'unknown-tier' | 'post-not-found' }
  | { ok: false; reason: 'ineligible'; ineligibility: PromotionIneligibility[] };

export async function startPromotionPurchase(input: {
  buyerOxyUserId: string;
  /** The buyer's feed profile is `protected` (a minor). */
  buyerIsProtected: boolean;
  postId: string;
  tierId: string;
}): Promise<PromotionPurchaseResult> {
  if (!MtnConfig.promotion.enabled) return { ok: false, reason: 'disabled' };
  const tier = promotionTier(input.tierId);
  if (!tier) return { ok: false, reason: 'unknown-tier' };

  const [post] = await loadPostRecords([input.postId]);
  // A post that is not the buyer's is reported as missing, not as "not yours":
  // existence of someone else's post is not this endpoint's to confirm.
  if (!post || post.oxyUserId !== input.buyerOxyUserId) {
    return { ok: false, reason: 'post-not-found' };
  }

  const [closed, open] = await Promise.all([
    accountsWithClosedAudience([post.oxyUserId ?? '']),
    findOpenPromotionForPost(post.id),
  ]);
  const ineligibility = promotionIneligibility(post, {
    buyerOxyUserId: input.buyerOxyUserId,
    buyerIsProtected: input.buyerIsProtected,
    authorAudienceClosed: closed.has(post.oxyUserId ?? ''),
    hasOpenPromotion: open !== null,
  });
  if (ineligibility.length > 0) return { ok: false, reason: 'ineligible', ineligibility };

  const promotion = await createPendingPromotion({
    postId: post.id,
    authorOxyUserId: input.buyerOxyUserId,
    tier,
  });
  // The unique index decided a concurrent purchase got there first.
  if (!promotion) return { ok: false, reason: 'ineligible', ineligibility: ['already-promoted'] };
  return { ok: true, promotion };
}
