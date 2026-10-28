import { sql } from 'drizzle-orm';
import { posts } from './posts';
import { check, date, integer, primaryKey, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from '@oxy.so/db';

/** Only the account/store relationship lives here. Catalog facts stay in Mercaria. */
export const accountStorefronts = pgTable('account_storefronts', {
  /** Oxy's foreign service identity, not a Mention user row. */
  oxyAccountId: text().primaryKey(),
  /** Canonical SDK formatMercariaRef output; never a mutable store handle. */
  mercariaRef: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Daily aggregate only: no visitor, session, IP, order or conversion data. */
export const commercePostDailyMetrics = pgTable('commerce_post_daily_metrics', {
  postId: text().notNull().references(() => posts.id, { onDelete: 'cascade' }),
  day: date().notNull(),
  opens: integer().notNull().default(0),
  handoffs: integer().notNull().default(0),
}, t => [primaryKey({ columns: [t.postId, t.day] }), check('commerce_post_metrics_nonnegative', sql`${t.opens} >= 0 and ${t.handoffs} >= 0`)]);

export const commerceStoreDailyMetrics = pgTable('commerce_store_daily_metrics', {
  oxyAccountId: text().notNull().references(() => accountStorefronts.oxyAccountId, { onDelete: 'cascade' }),
  day: date().notNull(),
  opens: integer().notNull().default(0),
  handoffs: integer().notNull().default(0),
}, t => [primaryKey({ columns: [t.oxyAccountId, t.day] }), check('commerce_store_metrics_nonnegative', sql`${t.opens} >= 0 and ${t.handoffs} >= 0`)]);
