/**
 * Reads and writes of `post_promotions` and its impression ledger.
 *
 * Every transition names the statuses it may come from, so a late webhook or a
 * second job tick cannot move a promotion backwards: the update matches nothing
 * and reports `false`.
 */

import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { MtnConfig, type MtnPromotionTier } from '@mention/shared-types';
import { getDb } from '../postgres';
import {
  OPEN_PROMOTION_STATUSES,
  type PromotionStatus,
  postPromotionImpressions,
  postPromotions,
} from '../schema/promotions';

export type PostPromotionRow = typeof postPromotions.$inferSelect;

/** The tier with this id, or undefined when it is not on sale. */
export function promotionTier(tierId: string): MtnPromotionTier | undefined {
  return MtnConfig.promotion.tiers.find((tier) => tier.id === tierId);
}

/** The UTC calendar day of an instant, as the ledger stores it. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

const hasCode = (value: unknown, code: string): boolean =>
  Boolean(value) && typeof value === 'object' && (value as { code?: unknown }).code === code;

/**
 * Start a purchase: a `pending_payment` promotion of the tier's impressions.
 * Returns `null` when the post already holds an open promotion (the unique
 * index decides, so two concurrent purchases cannot both succeed).
 */
export async function createPendingPromotion(input: {
  postId: string;
  authorOxyUserId: string;
  tier: MtnPromotionTier;
}): Promise<PostPromotionRow | null> {
  try {
    const [row] = await getDb()
      .insert(postPromotions)
      .values({
        postId: input.postId,
        authorOxyUserId: input.authorOxyUserId,
        tier: input.tier.id,
        purchasedImpressions: input.tier.impressions,
      })
      .returning();
    return row ?? null;
  } catch (error) {
    const cause = (error as { cause?: unknown })?.cause;
    if (hasCode(error, UNIQUE_VIOLATION) || hasCode(cause, UNIQUE_VIOLATION)) return null;
    throw error;
  }
}

/** The post's pending, active or paused promotion, if any. */
export async function findOpenPromotionForPost(postId: string): Promise<PostPromotionRow | null> {
  const [row] = await getDb()
    .select()
    .from(postPromotions)
    .where(
      and(
        eq(postPromotions.postId, postId),
        inArray(postPromotions.status, [...OPEN_PROMOTION_STATUSES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Payment confirmed: `pending_payment` -> `active`, with the window starting now
 * and lasting at most the tier's duration. `false` if it was not pending (a
 * repeated confirmation is a no-op, not a second window).
 */
export async function activatePromotion(input: {
  id: string;
  paymentRef: string;
  now: Date;
  durationHours: number;
}): Promise<boolean> {
  const endsAt = new Date(input.now.getTime() + input.durationHours * 3_600_000);
  const rows = await getDb()
    .update(postPromotions)
    .set({
      status: 'active',
      paymentRef: input.paymentRef,
      startsAt: input.now,
      endsAt,
      updatedAt: input.now,
    })
    .where(and(eq(postPromotions.id, input.id), eq(postPromotions.status, 'pending_payment')))
    .returning({ id: postPromotions.id });
  return rows.length > 0;
}

/** Move a promotion to `to`, only from one of `from`. */
export async function transitionPromotion(input: {
  id: string;
  from: readonly PromotionStatus[];
  to: PromotionStatus;
  now?: Date;
}): Promise<boolean> {
  const rows = await getDb()
    .update(postPromotions)
    .set({ status: input.to, updatedAt: input.now ?? new Date() })
    .where(and(eq(postPromotions.id, input.id), inArray(postPromotions.status, [...input.from])))
    .returning({ id: postPromotions.id });
  return rows.length > 0;
}

/**
 * Count one viewer's sight of a promotion for one UTC day. Returns whether this
 * call is the one that counted it: the primary key makes a repeated report from
 * the same viewer on the same day a no-op, which is what keeps the billable
 * number honest.
 */
export async function recordPromotionImpression(input: {
  promotionId: string;
  viewerOxyUserId: string;
  at: Date;
}): Promise<boolean> {
  const rows = await getDb()
    .insert(postPromotionImpressions)
    .values({
      promotionId: input.promotionId,
      viewerOxyUserId: input.viewerOxyUserId,
      day: utcDay(input.at),
    })
    .onConflictDoNothing()
    .returning({ promotionId: postPromotionImpressions.promotionId });
  return rows.length > 0;
}

/** Impressions counted so far for a promotion: the ledger is the truth. */
export async function countPromotionImpressions(promotionId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(postPromotionImpressions)
    .where(eq(postPromotionImpressions.promotionId, promotionId));
  return row?.n ?? 0;
}

/** The running promotions of these posts (a post has at most one open promotion). */
export async function listRunningPromotionsForPosts(
  postIds: readonly string[],
  now: Date,
): Promise<PostPromotionRow[]> {
  if (postIds.length === 0) return [];
  return getDb()
    .select()
    .from(postPromotions)
    .where(
      and(
        inArray(postPromotions.postId, [...postIds]),
        eq(postPromotions.status, 'active'),
        lte(postPromotions.startsAt, now),
        gt(postPromotions.endsAt, now),
      ),
    );
}

/**
 * Pause the post's running promotion, if it has one: what a report against the
 * post does while the report is looked at. Returns whether one was paused.
 */
export async function pauseRunningPromotionForPost(postId: string): Promise<boolean> {
  const rows = await getDb()
    .update(postPromotions)
    .set({ status: 'paused', updatedAt: new Date() })
    .where(and(eq(postPromotions.postId, postId), eq(postPromotions.status, 'active')))
    .returning({ id: postPromotions.id });
  return rows.length > 0;
}

/**
 * Promotions that are running at `now` and have views left to deliver. The
 * delivered counter is rolled up by the lifecycle job, so it lags the ledger by
 * one tick; a small overshoot is the price of not counting on every feed read.
 */
export async function listDeliverablePromotions(
  now: Date,
  limit: number,
): Promise<PostPromotionRow[]> {
  return getDb()
    .select()
    .from(postPromotions)
    .where(
      and(
        eq(postPromotions.status, 'active'),
        lte(postPromotions.startsAt, now),
        gt(postPromotions.endsAt, now),
        sql`${postPromotions.deliveredImpressions} < ${postPromotions.purchasedImpressions}`,
      ),
    )
    .limit(limit);
}
