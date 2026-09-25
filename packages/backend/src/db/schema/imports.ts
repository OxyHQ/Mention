/**
 * `post_imports` — the ledger of posts a user brought from another platform.
 *
 * Oxy Move reads a user's old Mastodon/Bluesky/… content and writes it into
 * Mention through the ingest API (`routes/imports.ts`, contract in
 * `docs/import.mdx`). Each imported post is an ORDINARY native post of its
 * author; this table is the only thing that knows it was imported, and it
 * carries three jobs at once:
 *
 * - **Deduplication.** `(oxy_user_id, platform, source_id)` is UNIQUE, so a
 *   re-sent item resolves to the post it already created instead of a second
 *   copy. It is also how a reply or quote names its parent by the SOURCE id.
 * - **Undo.** `import_batch_id` is Move's job id; deleting a batch walks the
 *   rows that carry it (indexed below).
 * - **Provenance.** Hydration reads `platform` + `source_url` to render
 *   "Originally posted on …", and the classifier reads the mere existence of a
 *   row to keep imports out of the live queue.
 *
 * ## `post_id` is the primary key, and it CASCADEs
 *
 * One post is imported at most once, so the post IS the row's identity. CASCADE
 * because the row describes the post and nothing else: when the post goes —
 * through undo, through the author deleting it, through moderation — the ledger
 * entry must go with it, or a re-import of the same source item would resolve to
 * a post that no longer exists.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { inList, timestamptz } from '@oxy.so/db';
import { IMPORT_PLATFORMS } from '@mention/shared-types';
import { posts } from './posts';

export const postImports = pgTable(
  'post_imports',
  {
    postId: text()
      .primaryKey()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /**
     * The author the post was imported FOR — an Oxy account id, no foreign key.
     * Denormalized from `posts.oxy_user_id` so the dedupe key and the undo scope
     * are answered by this table alone.
     */
    oxyUserId: text().notNull(),
    platform: text({ enum: IMPORT_PLATFORMS }).notNull(),
    /** The item's id on its platform (a Mastodon status id, an at-uri, …). */
    sourceId: text().notNull(),
    /** The item's public permalink on its platform. */
    sourceUrl: text().notNull(),
    /**
     * The content warning the item carried on its platform, verbatim.
     *
     * Native Mention posts have no content-warning TEXT — only the boolean
     * `metadata_is_sensitive` — so an imported CW would otherwise be reduced to a
     * blur with no label. Hydration surfaces it as `metadata.spoilerText`, the
     * same field a federated CW uses, so the reader sees the author's own words.
     */
    contentWarning: text(),
    /** Oxy Move's job id. A grouping token with no parent row here. */
    importBatchId: text().notNull(),
    importedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check(
      'post_imports_platform_check',
      sql`${t.platform} in (${sql.raw(inList(IMPORT_PLATFORMS))})`,
    ),
    unique('post_imports_source_key').on(t.oxyUserId, t.platform, t.sourceId),
    index('post_imports_batch_idx').on(t.importBatchId),
  ],
);
