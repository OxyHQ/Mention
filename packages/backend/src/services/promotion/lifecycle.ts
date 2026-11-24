/**
 * The life of a promotion after it is paid for: the delivered count follows the
 * ledger, a promotion that has delivered what was bought (or whose window has
 * closed) is completed, and an abandoned checkout is cancelled.
 *
 * `settlePromotions` is one pass and does the work; {@link PromotionLifecycleJob}
 * only decides when it runs. The pass reports what a completed promotion left
 * undelivered, because that number is what a refund is computed from: issuing the
 * refund belongs to the payment integration (see docs/boost.md), not here.
 */

import { and, eq, lt, lte, or, sql } from 'drizzle-orm';
import { MtnConfig } from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { postPromotionImpressions, postPromotions } from '../../db/schema/promotions';
import { logger } from '../../utils/logger';

/** How long a purchase may wait for its payment before it is given up. */
export const PENDING_PAYMENT_TTL_MS = 60 * 60 * 1000;

/** How often the job settles. */
export const PROMOTION_SETTLE_INTERVAL_MS = 5 * 60 * 1000;

export interface SettleResult {
  /** Promotions that ended, with what each left undelivered. */
  completed: Array<{ id: string; postId: string; undeliveredImpressions: number }>;
  /** Abandoned checkouts that were cancelled. */
  expired: number;
}

/** One settling pass. Idempotent: a second pass over the same state changes nothing. */
export async function settlePromotions(now: Date): Promise<SettleResult> {
  const db = getDb();

  // The ledger is the truth; the counter on the promotion only lets the feed
  // read progress without counting, so it is brought up to date first.
  await db.execute(sql`
    update ${postPromotions} p
    set delivered_impressions = c.n, updated_at = ${now.toISOString()}::timestamptz
    from (
      select i.promotion_id, count(*)::int as n
      from ${postPromotionImpressions} i
      join ${postPromotions} q on q.id = i.promotion_id and q.status in ('active', 'paused')
      group by i.promotion_id
    ) c
    where c.promotion_id = p.id and p.delivered_impressions <> c.n
  `);

  const ended = await db
    .update(postPromotions)
    .set({ status: 'completed', updatedAt: now })
    .where(
      and(
        eq(postPromotions.status, 'active'),
        or(
          sql`${postPromotions.deliveredImpressions} >= ${postPromotions.purchasedImpressions}`,
          lte(postPromotions.endsAt, now),
        ),
      ),
    )
    .returning({
      id: postPromotions.id,
      postId: postPromotions.postId,
      purchased: postPromotions.purchasedImpressions,
      delivered: postPromotions.deliveredImpressions,
    });

  const expired = await db
    .update(postPromotions)
    .set({ status: 'canceled', updatedAt: now })
    .where(
      and(
        eq(postPromotions.status, 'pending_payment'),
        lt(postPromotions.createdAt, new Date(now.getTime() - PENDING_PAYMENT_TTL_MS)),
      ),
    )
    .returning({ id: postPromotions.id });

  return {
    completed: ended.map((row) => ({
      id: row.id,
      postId: row.postId,
      undeliveredImpressions: Math.max(0, row.purchased - row.delivered),
    })),
    expired: expired.length,
  };
}

/** Runs {@link settlePromotions} on the elected leader only, and only while the feature is on. */
export class PromotionLifecycleJob {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => void this.tick(), PROMOTION_SETTLE_INTERVAL_MS);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** One guarded pass: off, overlapping, or failing never throws into the timer. */
  async tick(now: Date = new Date()): Promise<SettleResult | null> {
    if (!MtnConfig.promotion.enabled || this.running) return null;
    this.running = true;
    try {
      const result = await settlePromotions(now);
      if (result.completed.length > 0 || result.expired > 0) {
        logger.info('[PromotionLifecycle] settled', {
          completed: result.completed.length,
          expired: result.expired,
        });
      }
      return result;
    } catch (error) {
      logger.warn('[PromotionLifecycle] settle failed', { error });
      return null;
    } finally {
      this.running = false;
    }
  }
}

export const promotionLifecycleJob = new PromotionLifecycleJob();
