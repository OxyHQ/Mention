/** Private entitlement evidence; Peable remains the fiscal system of record. */
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { membershipCommunities, membershipTiers } from './memberships';

export const membershipBillingReceipts = pgTable(
  'membership_billing_receipts',
  {
    id: generatedId(),
    communityId: text()
      .notNull()
      .references(() => membershipCommunities.id, { onDelete: 'cascade' }),
    tierId: text().notNull(),
    payerOxyUserId: text().notNull(),
    invoiceId: text().notNull(),
    subscriptionId: text().notNull(),
    merchantId: text().notNull(),
    appId: text().notNull(),
    mode: text({ enum: ['test', 'live'] }).notNull(),
    environment: text({ enum: ['development', 'staging', 'production'] }).notNull(),
    offerId: text().notNull(),
    offerVersion: integer().notNull(),
    providerPriceId: text().notNull(),
    planId: text().notNull(),
    paymentIntentId: text().notNull(),
    providerCustomerId: text().notNull(),
    periodStart: timestamptz().notNull(),
    periodEnd: timestamptz().notNull(),
    paidAt: timestamptz().notNull(),
    observedAt: timestamptz().notNull(),
    state: text({ enum: ['paid', 'partially_refunded', 'fully_refunded'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tierId, t.communityId],
      foreignColumns: [membershipTiers.id, membershipTiers.communityId],
    }).onDelete('cascade'),
    unique('membership_billing_receipts_source_key').on(
      t.merchantId,
      t.appId,
      t.mode,
      t.environment,
      t.invoiceId,
    ),
    index('membership_billing_receipts_payer_idx').on(t.payerOxyUserId),
    index('membership_billing_receipts_community_idx').on(t.communityId),
    index('membership_billing_receipts_tier_idx').on(t.tierId, t.communityId),
    check('membership_billing_receipts_mode_check', sql`${t.mode} in ('test', 'live')`),
    check(
      'membership_billing_receipts_environment_check',
      sql`${t.environment} in ('development', 'staging', 'production')`,
    ),
    check(
      'membership_billing_receipts_state_check',
      sql`${t.state} in ('paid', 'partially_refunded', 'fully_refunded')`,
    ),
    check('membership_billing_receipts_period_check', sql`${t.periodEnd} > ${t.periodStart}`),
    check('membership_billing_receipts_version_check', sql`${t.offerVersion} > 0`),
  ],
);
