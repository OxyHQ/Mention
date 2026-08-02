/**
 * `channels`, `channel_members`, `channel_follows`, `lanes`, `lane_mutes`.
 *
 * A LANE is a lens — the publisher's own curation of posts that reach their
 * audience exactly as before. A CHANNEL is a DESTINATION: a post published to
 * one belongs to the channel and only to the channel, never appearing on its
 * author's profile or in their followers' timelines.
 *
 * ## The two identity columns are DERIVED, and that is load-bearing
 *
 * `channels.handle_lower` and `lanes.name_lower` are what the unique indexes are
 * built on, and Mongo derived both in a `pre('validate')` hook so no route,
 * script or test could arrive at a second spelling. A hook has no equivalent
 * here, so the derivation belongs to the repository that writes these rows —
 * and the constraint is the backstop that makes a missed derivation a refused
 * write instead of a duplicate channel.
 *
 * ## Counters live on `channels` and deliberately not on `lanes`
 *
 * `follower_count` / `member_count` / `post_count` are denormalized because the
 * channel directory RANKS by follower count and cannot aggregate per row. Each
 * has a single writer that already owns the transition. `lanes` has none, by the
 * same reasoning inverted: nothing ranks lanes.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  CHANNEL_MEMBER_ROLES,
  CHANNEL_MEMBER_STATUSES,
  CHANNEL_VISIBILITIES,
  LANE_DISPLAY_MODES,
  LANE_OWNER_TYPES,
} from '@mention/shared-types';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from './columns';

/** `channels` — a shared destination people follow without following its authors. */
export const channels = pgTable(
  'channels',
  {
    id: generatedId(),
    handle: text().notNull(),
    /**
     * The canonical identity the unique index is built on. DERIVED from
     * `handle` by `normalizeChannelHandle`, never supplied by a caller — see the
     * module docblock.
     */
    handleLower: text().notNull(),
    title: text().notNull(),
    description: text(),
    /** A bare Oxy file id. Never a URL — media resolution is the SDK's chokepoint. */
    avatar: text(),
    /** A bare Oxy file id. Never a URL — media resolution is the SDK's chokepoint. */
    banner: text(),
    /** An Oxy account id — no foreign key. */
    ownerOxyUserId: text().notNull(),
    visibility: text({ enum: CHANNEL_VISIBILITIES }).notNull().default('public'),
    /**
     * Whether a channel post also names the person who wrote it. `false` means
     * the post is anonymous behind the channel, enforced in the DTO
     * (`PostHydrationService`) rather than in the renderer.
     */
    signPosts: boolean().notNull().default(false),
    followerCount: integer().notNull().default(0),
    memberCount: integer().notNull().default(0),
    postCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'channels_visibility_check',
      sql`${t.visibility} in (${sql.raw(inList(CHANNEL_VISIBILITIES))})`
    ),
    // Every counter is a `$inc` in Mongo, where a decrement race could take one
    // negative and nothing would notice. Here it cannot.
    check(
      'channels_counts_check',
      sql`${t.followerCount} >= 0 and ${t.memberCount} >= 0 and ${t.postCount} >= 0`
    ),
    /** The channel's global identity, and the `/c/<handle>` lookup. */
    uniqueIndex('channels_handle_lower_key').on(t.handleLower),
    /** An owner's own channels, newest first — the management screen. */
    index('channels_owner_chrono_idx').on(t.ownerOxyUserId, t.createdAt.desc()),
    /** The directory's keyset: most-followed first, id breaking the tie. */
    index('channels_directory_idx').on(t.visibility, t.followerCount.desc(), t.id.desc()),
  ]
);

/** `channel_members` — who may publish to a channel. */
export const channelMembers = pgTable(
  'channel_members',
  {
    id: generatedId(),
    channelId: text()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    role: text({ enum: CHANNEL_MEMBER_ROLES }).notNull().default('publisher'),
    status: text({ enum: CHANNEL_MEMBER_STATUSES }).notNull().default('pending'),
    /** Who sent the invite. Absent on the owner's own founding row. */
    invitedByOxyUserId: text(),
    invitedAt: timestamptz(),
    respondedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('channel_members_role_check', sql`${t.role} in (${sql.raw(inList(CHANNEL_MEMBER_ROLES))})`),
    check(
      'channel_members_status_check',
      sql`${t.status} in (${sql.raw(inList(CHANNEL_MEMBER_STATUSES))})`
    ),
    // The natural key. One membership per person per channel, which is what
    // makes an interrupted backfill converge rather than duplicate.
    unique('channel_members_channel_id_oxy_user_id_key').on(t.channelId, t.oxyUserId),
    index('channel_members_channel_status_idx').on(t.channelId, t.status),
    index('channel_members_user_status_idx').on(t.oxyUserId, t.status),
  ]
);

/** `channel_follows` — who receives a channel's posts. */
export const channelFollows = pgTable(
  'channel_follows',
  {
    id: generatedId(),
    channelId: text()
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    notify: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('channel_follows_oxy_user_id_channel_id_key').on(t.oxyUserId, t.channelId),
    /** The viewer's own follows, newest first — the `ChronoCursor` keyset. */
    index('channel_follows_by_user_idx').on(t.oxyUserId, t.createdAt.desc(), t.id.desc()),
    /** Fan-out: who to notify about a channel's new post. */
    index('channel_follows_channel_notify_idx').on(t.channelId, t.notify, t.id),
  ]
);

/** `lanes` — a publisher's named track, curating the profile it shows on. */
export const lanes = pgTable(
  'lanes',
  {
    id: generatedId(),
    ownerType: text({ enum: LANE_OWNER_TYPES }).notNull(),
    /** The publisher's id: an Oxy account id for `user`, a channel id for `channel`. */
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
    check('lanes_owner_type_check', sql`${t.ownerType} in (${sql.raw(inList(LANE_OWNER_TYPES))})`),
    check(
      'lanes_display_mode_check',
      sql`${t.displayMode} in (${sql.raw(inList(LANE_DISPLAY_MODES))})`
    ),
    // Uniqueness is per PUBLISHER, which is why `owner_type` is in the key: a
    // user and a channel may hold the same lane name.
    unique('lanes_owner_name_lower_key').on(t.ownerType, t.ownerId, t.nameLower),
    index('lanes_owner_idx').on(t.ownerType, t.ownerId, t.createdAt.desc()),
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
