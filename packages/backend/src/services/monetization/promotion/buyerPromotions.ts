/**
 * What a buyer can read and undo of their own promotions (docs/boost.md). The
 * routes call these instead of reaching into the repository, which keeps the
 * layering the architecture guard enforces.
 */

import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../../db/postgres';
import {
  pauseRunningPromotionForPost,
  transitionPromotion,
} from '../../../db/promotions/promotionRepository';
import { postPromotions } from '../../../db/schema/promotions';

type PromotionRow = typeof postPromotions.$inferSelect;

/** What a client may read of its own promotion. */
export function promotionView(row: PromotionRow) {
  return {
    id: row.id,
    postId: row.postId,
    tier: row.tier,
    status: row.status,
    purchasedImpressions: row.purchasedImpressions,
    deliveredImpressions: row.deliveredImpressions,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdAt: row.createdAt,
  };
}

/** The buyer's promotions, newest first; `postId` narrows it to one post. */
export async function listBuyerPromotions(buyerOxyUserId: string, postId?: string) {
  const rows = await getDb()
    .select()
    .from(postPromotions)
    .where(eq(postPromotions.authorOxyUserId, buyerOxyUserId))
    .orderBy(desc(postPromotions.createdAt))
    .limit(50);
  return rows.filter((row) => !postId || row.postId === postId).map(promotionView);
}

export type CancelPurchaseResult = 'canceled' | 'not-found' | 'not-cancelable';

/** Cancel an unpaid purchase. Someone else's promotion reads as absent. */
export async function cancelPromotionPurchase(
  buyerOxyUserId: string,
  promotionId: string,
): Promise<CancelPurchaseResult> {
  const [row] = await getDb()
    .select()
    .from(postPromotions)
    .where(eq(postPromotions.id, promotionId))
    .limit(1);
  if (!row || row.authorOxyUserId !== buyerOxyUserId) return 'not-found';
  const canceled = await transitionPromotion({
    id: row.id,
    from: ['pending_payment'],
    to: 'canceled',
  });
  return canceled ? 'canceled' : 'not-cancelable';
}

/** A report against a promoted post pauses its running promotion while it is looked at. */
export async function pausePromotionForReportedPost(postId: string): Promise<void> {
  await pauseRunningPromotionForPost(postId);
}
