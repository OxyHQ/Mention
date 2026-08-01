/**
 * `polls`, `poll_options`, `poll_votes` — ported from `models/Poll.ts`.
 *
 * Mongo held the options as an embedded array whose subdocuments each carried
 * their own `_id` (`{ _id: true }`) plus a `votes: [String]` array of voter ids.
 * That is two arrays of ids nested two levels deep, and the id of an option is
 * published to clients as the thing they POST back when voting — so both become
 * real tables.
 *
 * ## `post_id` was `Mixed`, and that is now gone
 *
 * `PollSchema.postId` was `Schema.Types.Mixed` with a validator accepting EITHER
 * an ObjectId OR a string starting `temp_`, because the composer creates a poll
 * before the post exists and patches the real id in afterwards
 * (`polls.controller.ts:372`). A `temp_` placeholder is a write-order artefact,
 * not data: here the column is a real nullable foreign key, NULL until the post
 * is created. The backfill maps every `temp_` value to NULL.
 *
 * That also removes the one Mongoose validator in this codebase that FAILS a
 * write on an unrecognised id shape — worth knowing, because it is the only
 * place an id-format change breaks loudly rather than silently.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from './columns';
import { posts } from './posts';

export const polls = pgTable(
  'polls',
  {
    id: generatedId(),
    question: text().notNull(),
    /**
     * The post this poll is attached to.
     *
     * NULLABLE and CASCADE: nullable because a poll is created before its post
     * (see the module docblock), CASCADE because `deletePost` already deletes
     * the poll (`posts.controller.ts:1738`).
     */
    postId: text().references(() => posts.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    createdBy: text().notNull(),
    endsAt: timestamptz().notNull(),
    isMultipleChoice: boolean().notNull().default(false),
    isAnonymous: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('polls_created_by_idx').on(t.createdBy),
    index('polls_ends_at_idx').on(t.endsAt),
    // Mongo's partial index `{postId: 1}` filtered on `$type: 'objectId'` — the
    // partial existed only to exclude the `temp_` strings, which no longer
    // exist, so the analogue is "where the poll is actually attached".
    index('polls_post_id_idx')
      .on(t.postId)
      .where(sql`${t.postId} is not null`),
  ]
);

/**
 * `poll_options` — one choice. Its `id` is what clients POST back when voting,
 * so it is a first-class id rather than an array index.
 */
export const pollOptions = pgTable(
  'poll_options',
  {
    id: generatedId(),
    pollId: text()
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    /** Preserves the order the author wrote the options in. */
    position: integer().notNull(),
    text: text().notNull(),
  },
  (t) => [
    check('poll_options_position_check', sql`${t.position} >= 0`),
    unique('poll_options_poll_id_position_key').on(t.pollId, t.position),
  ]
);

/**
 * `poll_votes` — one row per (option, voter).
 *
 * Mongo held `votes: [String]` INSIDE each option, so "has this user voted"
 * meant scanning every option's array and the total was a virtual that summed
 * them. Here it is a junction table, so a single-choice poll's "one vote per
 * poll" rule is expressible (the partial unique index below) and the tally is a
 * `GROUP BY`.
 */
export const pollVotes = pgTable(
  'poll_votes',
  {
    id: generatedId(),
    optionId: text()
      .notNull()
      .references(() => pollOptions.id, { onDelete: 'cascade' }),
    /**
     * Denormalized from the option so the one-vote-per-poll rule below can be a
     * UNIQUE constraint. Kept in lockstep by the writer; a CHECK cannot reach
     * across to `poll_options.poll_id`.
     */
    pollId: text()
      .notNull()
      .references(() => polls.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    userId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('poll_votes_option_id_user_id_key').on(t.optionId, t.userId),
    // Reading a poll always reads all of its votes.
    index('poll_votes_poll_id_idx').on(t.pollId),
    // "Did I vote on this poll" — the viewer-state lookup.
    index('poll_votes_poll_id_user_id_idx').on(t.pollId, t.userId),
  ]
);
