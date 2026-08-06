/**
 * `lanes` and `lane_mutes`.
 *
 * A LANE is a lens: the publisher's own curation of posts that reach their
 * audience exactly as before. A post carrying one stays an ORDINARY post —
 * distribution, visibility, replies and federation are untouched.
 *
 * ## There is no `channels` table, and that is the design rather than a gap
 *
 * A channel is an Oxy ACCOUNT (`kind: 'channel'`), not a Mention row: a channel
 * post is authored BY it, so it carries the channel in `posts.oxy_user_id` and
 * `post_authorships` like any other author, and following a channel is an
 * ordinary Oxy follow. `channels`, `channel_members` and `channel_follows`
 * existed only to express the FIRST design, in which a channel was a
 * Mention-local destination and a post published TO one; they were dropped by
 * `0017_a_channel_is_an_account`, together with `posts.channel_id`. Nothing here
 * replaces them — the account graph Oxy owns is where membership lives, and
 * Postgres cannot see it.
 *
 * ## `name_lower` is DERIVED, and that is load-bearing
 *
 * `lanes.name_lower` is what the unique index is built on, and Mongo derived it
 * in a `pre('validate')` hook so no route, script or test could arrive at a
 * second spelling. A hook has no equivalent here, so the derivation belongs to
 * the repository that writes these rows — and the constraint is the backstop
 * that makes a missed derivation a refused write instead of a duplicate lane.
 *
 * ## `lanes` carries no counter, deliberately
 *
 * Nothing ranks lanes, so there is nothing to denormalize and nothing to drift.
 * The management screen aggregates on read.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { LANE_DISPLAY_MODES } from '@mention/shared-types';
import { createdAt, generatedId, inList, updatedAt } from '@oxyhq/db';

/** `lanes` — a publisher's named track, curating the profile it shows on. */
export const lanes = pgTable(
  'lanes',
  {
    id: generatedId(),
    /**
     * The publisher's `oxyUserId` — a person or a channel ACCOUNT alike.
     *
     * There is no `owner_type` beside it. It existed because a channel used to be
     * a Mention row whose id came from a different id space; a channel is an Oxy
     * account now, so the discriminator had exactly one reachable value, and a
     * single-valued discriminator is a branch every reader has to prove is dead.
     * Dropped by `0017_a_channel_is_an_account`.
     */
    ownerId: text().notNull(),
    name: text().notNull(),
    /**
     * Case/whitespace-normalized identity, so uniqueness is per publisher and
     * case-insensitive. DERIVED from `name`; see the module docblock.
     */
    nameLower: text().notNull(),
    displayMode: text({ enum: LANE_DISPLAY_MODES }).notNull().default('mixed'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'lanes_display_mode_check',
      sql`${t.displayMode} in (${sql.raw(inList(LANE_DISPLAY_MODES))})`
    ),
    // One name per PUBLISHER. `owner_id` alone is the key now that a publisher is
    // always an Oxy account: under the old `(owner_type, owner_id, name_lower)`
    // key one publisher could hold the same lane name twice, once per owner type.
    unique('lanes_owner_name_lower_key').on(t.ownerId, t.nameLower),
    index('lanes_owner_idx').on(t.ownerId, t.createdAt.desc()),
  ]
);

/** `lane_mutes` — a viewer hiding one publisher's lane. */
export const laneMutes = pgTable(
  'lane_mutes',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    viewerOxyUserId: text().notNull(),
    laneId: text()
      .notNull()
      .references(() => lanes.id, { onDelete: 'cascade' }),
    /** Denormalized: groups the settings screen by publisher, with no join. */
    laneOwnerOxyUserId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('lane_mutes_viewer_lane_key').on(t.viewerOxyUserId, t.laneId),
    index('lane_mutes_viewer_chrono_idx').on(t.viewerOxyUserId, t.createdAt.desc()),
  ]
);
