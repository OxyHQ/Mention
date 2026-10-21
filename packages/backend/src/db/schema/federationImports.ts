/** Private import evidence; never joined into public post hydration. */
import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { createdAt, inList } from '@oxy.so/db';
import { posts } from './posts';

export const FEDERATION_IMPORT_REASONS = [
  'discovery_backfill',
  'followed_outbox',
  'requested_profile',
  'inbox_follow',
  'inbox_mention',
  'inbox_community',
  'inbox_announce',
  'boost_dependency',
  'quote_dependency',
  'reply_dependency',
  'unknown_outbox',
] as const;
export type FederationImportReason = (typeof FEDERATION_IMPORT_REASONS)[number];

export const federationPostImports = pgTable(
  'federation_post_imports',
  {
    postId: text()
      .primaryKey()
      .references(() => posts.id, { onDelete: 'cascade' }),
    // Null for an existing post first observed after this ledger was introduced.
    // Only the transaction inserting a NEW post can assert its original cause.
    initialReason: text({ enum: FEDERATION_IMPORT_REASONS }),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      'federation_post_imports_reason_check',
      sql`${table.initialReason} in (${sql.raw(inList(FEDERATION_IMPORT_REASONS))})`,
    ),
  ],
);

export const federationPostImportReasons = pgTable(
  'federation_post_import_reasons',
  {
    postId: text()
      .notNull()
      .references(() => federationPostImports.postId, { onDelete: 'cascade' }),
    reason: text({ enum: FEDERATION_IMPORT_REASONS }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.reason] }),
    check(
      'federation_post_import_reasons_reason_check',
      sql`${table.reason} in (${sql.raw(inList(FEDERATION_IMPORT_REASONS))})`,
    ),
  ],
);
