/**
 * Paid distribution of a post (the "Boost" a person buys for their own post).
 *
 * A promotion is a purchase of `purchasedImpressions` views, spent over a window,
 * delivered through the ordinary ranked feed (see `docs/boost.md`). Nothing here
 * is a billing record: Peable stays the fiscal system of record and `paymentRef`
 * only names the invoice, so a refund or an audit starts from Peable's side.
 *
 * Named `promotion` in code because "boost" still means "repost" in stored
 * values and old wire names until that rename completes; the word people see is
 * a client concern.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { posts } from './posts';

/** Where a promotion is in its life. The CHECK below is the union of these. */
export const PROMOTION_STATUSES = [
  'pending_payment',
  'active',
  'paused',
  'completed',
  'canceled',
  'refunded',
] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/** The statuses in which a post already holds a promotion, so it cannot buy a second. */
export const OPEN_PROMOTION_STATUSES = ['pending_payment', 'active', 'paused'] as const;

export const postPromotions = pgTable(
  'post_promotions',
  {
    id: generatedId(),
    /** The promoted post. Deleting the post ends its promotion (the app settles a refund first). */
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /** Whoever bought it; always the post's author (checked at purchase). */
    authorOxyUserId: text().notNull(),
    /** The tier bought, a key of `MtnConfig.promotion.tiers`. Prices come from the payment catalogue. */
    tier: text().notNull(),
    purchasedImpressions: integer().notNull(),
    /** Rolled up from the impression ledger by the lifecycle job; the ledger is the truth. */
    deliveredImpressions: integer().notNull().default(0),
    status: text({ enum: PROMOTION_STATUSES }).notNull().default('pending_payment'),
    /** Set when payment confirms. */
    startsAt: timestamptz(),
    endsAt: timestamptz(),
    /** Peable's reference for the paid invoice. Set when payment confirms. */
    paymentRef: text(),
    createdAt: createdAt(),
    updatedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    // One open promotion per post: a second purchase must wait for the first to end.
    uniqueIndex('post_promotions_one_open_per_post_key')
      .on(t.postId)
      .where(sql`${t.status} in ('pending_payment', 'active', 'paused')`),
    // The lifecycle job: what is active and when does it end.
    index('post_promotions_status_ends_idx').on(t.status, t.endsAt),
    index('post_promotions_author_idx').on(t.authorOxyUserId, t.createdAt),
    check(
      'post_promotions_status_check',
      sql`${t.status} in ('pending_payment', 'active', 'paused', 'completed', 'canceled', 'refunded')`,
    ),
    check('post_promotions_purchased_check', sql`${t.purchasedImpressions} > 0`),
    check('post_promotions_delivered_check', sql`${t.deliveredImpressions} >= 0`),
    check('post_promotions_window_check', sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    // A promotion that is running has a window and a payment behind it.
    check(
      'post_promotions_active_paid_check',
      sql`${t.status} <> 'active' or (${t.startsAt} is not null and ${t.endsAt} is not null and ${t.paymentRef} is not null)`,
    ),
  ],
);

/**
 * One row per viewer, per promotion, per UTC day on which the post was seen. It
 * is both the billing ledger (the unique key is what makes a repeated report
 * count once) and the frequency cap (a viewer already counted today is not
 * shown it again).
 */
export const postPromotionImpressions = pgTable(
  'post_promotion_impressions',
  {
    promotionId: text()
      .notNull()
      .references(() => postPromotions.id, { onDelete: 'cascade' }),
    viewerOxyUserId: text().notNull(),
    day: date({ mode: 'string' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'post_promotion_impressions_pk',
      columns: [t.promotionId, t.viewerOxyUserId, t.day],
    }),
    // "What has this viewer already been shown": the feed's exclusion lookup.
    index('post_promotion_impressions_viewer_idx').on(t.viewerOxyUserId, t.day),
  ],
);
