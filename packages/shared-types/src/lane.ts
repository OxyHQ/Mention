/**
 * Lanes — a publisher's own named carriageways through their output.
 *
 * A lane is a LENS, never a destination. A post that carries one is an ordinary
 * post: same distribution, same visibility, same federation, same replies. What
 * the lane adds is two things and only two:
 *
 *  - the OWNER curates their showcase with {@link LaneDisplayMode}, and
 *  - a READER can mute one lane of one publisher without unfollowing them.
 *
 * A lane belongs to a PUBLISHER, and a publisher is a user OR a channel
 * ({@link LaneOwnerType}) — channels curate their own page exactly the way a user
 * curates a profile. The polymorphic owner exists from the first row on purpose:
 * adding it later would mean migrating every lane already written.
 *
 * There is deliberately NO slug (the tab routes by id, so a rename cannot break a
 * URL) and NO denormalized post count (a wrong counter is worse than none — the
 * management screen aggregates).
 */

import type { PostUser } from './post';

/** Who a lane belongs to. A channel curates its page the way a user curates a profile. */
export type LaneOwnerType = 'user' | 'channel';

/**
 * Where the publisher's showcase shows a lane's posts.
 *
 * - `mixed`  — the default: the posts appear on the main tab, like any other post.
 * - `tab`    — off the main tab; reachable only through the lane's own tab.
 * - `hidden` — off the showcase entirely, INCLUDING for the owner. The posts are
 *   still distributed to feeds and still reachable by URL: this is curation of a
 *   showcase, not privacy.
 */
export type LaneDisplayMode = 'mixed' | 'tab' | 'hidden';

/** {@link LaneDisplayMode} as a runtime list, for validation and pickers. */
export const LANE_DISPLAY_MODES = [
  'mixed',
  'tab',
  'hidden',
] as const satisfies readonly LaneDisplayMode[];

/** {@link LaneOwnerType} as a runtime list, for validation. */
export const LANE_OWNER_TYPES = ['user', 'channel'] as const satisfies readonly LaneOwnerType[];

/** Narrow an arbitrary string to a {@link LaneDisplayMode}. */
export function isLaneDisplayMode(value: string | undefined): value is LaneDisplayMode {
  return value !== undefined && (LANE_DISPLAY_MODES as readonly string[]).includes(value);
}

/** Narrow an arbitrary string to a {@link LaneOwnerType}. */
export function isLaneOwnerType(value: string | undefined): value is LaneOwnerType {
  return value !== undefined && (LANE_OWNER_TYPES as readonly string[]).includes(value);
}

/** A lane as its owner manages it. */
export interface Lane {
  id: string;
  ownerType: LaneOwnerType;
  /** The publisher's id: an `oxyUserId` for `user`, a channel id for `channel`. */
  ownerId: string;
  name: string;
  displayMode: LaneDisplayMode;
  createdAt: string;
  updatedAt: string;
  /**
   * How many posts currently sit in the lane. Aggregated on read by the
   * management endpoint (`GET /lanes/mine`) — never stored, so it cannot drift.
   * Absent on every other surface.
   */
  postCount?: number;
}

/**
 * What a lane looks like ON A POST's DTO — the chip in the name row.
 *
 * The owner is deliberately absent: the post already carries its author, and a
 * lane always belongs to the same publisher as the post it is on.
 */
export interface LaneSummary {
  id: string;
  name: string;
  displayMode: LaneDisplayMode;
}

/**
 * One entry of the reader's muted-lane list. The owner is a canonical Oxy
 * {@link PostUser}, resolved through the same identity path every other author
 * goes through, so the settings screen can group mutes by publisher.
 */
export interface MutedLane {
  lane: LaneSummary;
  owner: PostUser;
  createdAt: string;
}

export interface CreateLaneRequest {
  name: string;
  displayMode?: LaneDisplayMode;
}

export interface UpdateLaneRequest {
  name?: string;
  displayMode?: LaneDisplayMode;
}

/** Maximum lanes one publisher (user or channel) may define. */
export const MAX_LANES_PER_OWNER = 20;

/** Maximum length of a lane name (mirrors the model `maxlength`). */
export const MAX_LANE_NAME_LENGTH = 40;

/** Maximum lanes one reader may mute. */
export const MAX_MUTED_LANES = 200;
