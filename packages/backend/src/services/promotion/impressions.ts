/**
 * Counting what a promotion delivered.
 *
 * The client already reports every post it showed (`feed_interactions`,
 * `impression`). When the post of such a report has a running promotion, the
 * viewer is written into the promotion's ledger for that UTC day. The ledger's
 * primary key makes a repeated report count once, which is what keeps the number
 * that is billed honest even though the report is client-controlled.
 *
 * A viewer never counts for their own post (an author cannot spend their own
 * purchase by looking at it), and nothing is counted outside the promotion's
 * window or while the feature is switched off.
 */

import { MtnConfig } from '@mention/shared-types';
import {
  listRunningPromotionsForPosts,
  recordPromotionImpression,
} from '../../db/promotions/promotionRepository';

/** One reported sight of a post. */
export interface ReportedImpression {
  viewerOxyUserId: string;
  postId: string;
  at: Date;
}

/** Count the reported sights that belong to a running promotion. Returns how many were new. */
export async function recordPromotionImpressions(
  impressions: readonly ReportedImpression[],
): Promise<number> {
  if (!MtnConfig.promotion.enabled || impressions.length === 0) return 0;

  const now = new Date();
  const running = await listRunningPromotionsForPosts(
    [...new Set(impressions.map((impression) => impression.postId))],
    now,
  );
  if (running.length === 0) return 0;
  const byPost = new Map(running.map((promotion) => [promotion.postId, promotion]));

  let counted = 0;
  for (const impression of impressions) {
    const promotion = byPost.get(impression.postId);
    if (!promotion || promotion.authorOxyUserId === impression.viewerOxyUserId) continue;
    // The sight must have happened inside the window, not merely be reported inside it.
    if (
      !promotion.startsAt ||
      !promotion.endsAt ||
      impression.at < promotion.startsAt ||
      impression.at >= promotion.endsAt
    ) {
      continue;
    }
    const isNew = await recordPromotionImpression({
      promotionId: promotion.id,
      viewerOxyUserId: impression.viewerOxyUserId,
      at: impression.at,
    });
    if (isNew) counted += 1;
  }
  return counted;
}
