import { pgTable, text } from 'drizzle-orm/pg-core';
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
