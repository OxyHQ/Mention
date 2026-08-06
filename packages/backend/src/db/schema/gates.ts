/**
 * `threadgates` and `postgates` — who may reply to, and who may quote, a post.
 *
 * Both key on `post_uri`, an MTN URI that embeds the post's Mongo `_id`
 * (`mtn://<oxyUserId>/app.mention.feed.post/<postId>`). Mongo made it UNIQUE and
 * it stays unique; `post_id` alongside it is the same id in bare form, kept
 * because different read paths use one or the other.
 *
 * NEITHER carries a foreign key to `posts`, and that is decided rather than
 * overlooked: `routes/posts.ts` mints the URI from a client-supplied post id and
 * upserts the gate on `{ postUri }` without first proving the post exists, so a
 * constraint here would turn a race (or a gate written for a post that is later
 * deleted) into a 500 on a path that today degrades to "no gate". Both columns
 * are enumerated in `ID_COLUMNS_WITHOUT_FOREIGN_KEY`.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';

/** `IThreadgate.allow[].type`. */
export const THREADGATE_ALLOW_TYPES = [
  'mentionedOnly',
  'followingOnly',
  'followerOnly',
  'listOnly',
] as const;

/** `threadgates` — reply control for one post. */
export const threadgates = pgTable(
  'threadgates',
  {
    id: generatedId(),
    postUri: text().notNull().unique('threadgates_post_uri_key'),
    /** The bare post id. No foreign key — see the module docblock. */
    postId: text().notNull(),
    /** An Oxy account id — no foreign key. */
    createdBy: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('threadgates_post_id_idx').on(t.postId),
    index('threadgates_created_by_idx').on(t.createdBy),
  ]
);

/**
 * `threadgate_allow_rules` — the `allow[]` array, one row per rule.
 *
 * Mongo embedded `{ type, list? }` objects. As rows the `listOnly` invariant
 * becomes expressible: a `listOnly` rule is meaningless without a list id, and
 * every other rule is meaningless with one.
 */
export const threadgateAllowRules = pgTable(
  'threadgate_allow_rules',
  {
    id: generatedId(),
    threadgateId: text()
      .notNull()
      .references(() => threadgates.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    type: text({ enum: THREADGATE_ALLOW_TYPES }).notNull(),
    /**
     * An `account_lists.id`, for `listOnly`. Deliberately unconstrained for the
     * same reason as `threadgates.post_id`: the rule is authored from a client
     * payload and a dead list must degrade to "matches nobody", not to a 500.
     */
    listId: text(),
  },
  (t) => [
    check(
      'threadgate_allow_rules_type_check',
      sql`${t.type} in (${sql.raw(inList(THREADGATE_ALLOW_TYPES))})`
    ),
    check(
      'threadgate_allow_rules_list_id_check',
      sql`(${t.type} = 'listOnly') = (${t.listId} is not null)`
    ),
    check('threadgate_allow_rules_position_check', sql`${t.position} >= 0`),
    unique('threadgate_allow_rules_threadgate_id_position_key').on(t.threadgateId, t.position),
  ]
);

/** `postgates` — quote control for one post. */
export const postgates = pgTable(
  'postgates',
  {
    id: generatedId(),
    postUri: text().notNull().unique('postgates_post_uri_key'),
    /** The bare post id. No foreign key — see the module docblock. */
    postId: text().notNull(),
    disableQuotes: boolean().notNull().default(false),
    /**
     * MTN URIs of quotes the author detached. A scalar list of opaque URIs,
     * never joined and never queried by element — so a `text[]`, not a junction.
     */
    detachedQuoteUris: text().array(),
    /** An Oxy account id — no foreign key. */
    createdBy: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('postgates_post_id_idx').on(t.postId),
    index('postgates_created_by_idx').on(t.createdBy),
  ]
);
