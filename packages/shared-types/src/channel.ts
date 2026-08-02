/**
 * Channels — a shared, multi-user DESTINATION, in the Telegram-channel sense.
 *
 * A channel has an owner, invited members who may publish, and followers who only
 * read. The whole point is that **people follow the channel without following its
 * authors**: a reader who wants one publication does not have to take on the
 * personal timeline of everybody who writes for it.
 *
 * Three rules shape every type below, and each of them is a rule somebody
 * "simplifies" wrongly later:
 *
 *  1. **The channel is the byline.** A channel post renders with the CHANNEL's
 *     avatar and name. It is NOT a `PostUser` and must never be turned into one —
 *     Oxy owns identity, and a fabricated user breaks `/@handle` links and the
 *     identity cache. That is why {@link ChannelSummary} rides on the post DTO as
 *     its own field and the renderer decides which signature to paint.
 *  2. **No replies, ever.** A channel is a newspaper: read, like, save, quote,
 *     boost. The refusal is STRUCTURAL — keyed off the post's `channelId`, never
 *     off `replyPermission`, which a later settings write could change.
 *  3. **A channel post is only in the channel.** There is no `channelOnly` flag: a
 *     post that carries a `channelId` never appears on its author's profile or in
 *     their followers' timeline. To put it on your own profile you BOOST it, which
 *     is Telegram's forward and already renders correctly.
 *
 * Channels also have lanes ({@link LaneOwnerType} `'channel'`) so a channel curates
 * its own page the way a user curates a profile.
 */

import type { PostUser } from './post';

/**
 * How much of a channel is public.
 *
 * Stored even though `'public'` is the only value today: a restricted level adds a
 * SECOND visibility axis alongside `post.visibility` and would have to be audited
 * across every read surface before it is switched on. Having the column already
 * means that day is widening an enum, not migrating a collection.
 */
export type ChannelVisibility = 'public';

/**
 * {@link ChannelVisibility} as a runtime list, for validation.
 *
 * `as const satisfies` rather than a `readonly X[]` annotation: the annotation
 * widens the value to an ARRAY, and drizzle's `text({ enum })` requires a
 * non-empty TUPLE — so the backend schema could not consume this list at all
 * and would have had to restate the values, which is the drift this constant
 * exists to prevent. `satisfies` keeps the membership check the annotation gave.
 */
export const CHANNEL_VISIBILITIES = ['public'] as const satisfies readonly ChannelVisibility[];

/**
 * What a member may do.
 *
 * - `owner`     — manages the channel: its profile, its lanes, and its membership.
 * - `publisher` — publishes to it, and nothing else.
 */
export type ChannelMemberRole = 'owner' | 'publisher';

/** {@link ChannelMemberRole} as a runtime list, for validation. */
export const CHANNEL_MEMBER_ROLES = [
  'owner',
  'publisher',
] as const satisfies readonly ChannelMemberRole[];

/**
 * Where a membership invite stands.
 *
 * The vocabulary is copied verbatim from `PostAuthorshipEntry` on collaborative
 * posts, which has the same shape and is already proven — somebody who has read
 * one understands the other with no second model in their head.
 */
export type ChannelMemberStatus = 'pending' | 'accepted' | 'declined' | 'removed';

/** {@link ChannelMemberStatus} as a runtime list, for validation. */
export const CHANNEL_MEMBER_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'removed',
] as const satisfies readonly ChannelMemberStatus[];

/** Narrow an arbitrary string to a {@link ChannelMemberRole}. */
export function isChannelMemberRole(value: string | undefined): value is ChannelMemberRole {
  return value !== undefined && (CHANNEL_MEMBER_ROLES as readonly string[]).includes(value);
}

/** Shortest accepted channel handle. */
export const CHANNEL_HANDLE_MIN_LENGTH = 3;

/** Longest accepted channel handle. */
export const CHANNEL_HANDLE_MAX_LENGTH = 30;

/** Longest accepted channel title. */
export const MAX_CHANNEL_TITLE_LENGTH = 60;

/** Longest accepted channel description. */
export const MAX_CHANNEL_DESCRIPTION_LENGTH = 300;

/**
 * Most channels one user may own. A bound rather than a product rule: a channel is
 * a globally-addressable handle, and an unbounded per-user allowance is a handle
 * land-grab waiting to happen.
 */
export const MAX_CHANNELS_PER_OWNER = 20;

/**
 * Most members (owner included) one channel may have. Bounds the management screen
 * and the publish-time authorization lookup; mirrors the cap starter packs already
 * enforce on their own member list.
 */
export const MAX_CHANNEL_MEMBERS = 150;

/**
 * How many followers one published channel post may notify inline.
 *
 * The notification stage runs inside the post-creation pipeline, which is AWAITED,
 * so a channel with a hundred thousand followers would block every publish behind
 * its own fan-out. Beyond this cap the fan-out belongs in a BullMQ job. The cap
 * mirrors `MAX_SUBSCRIBED_LIST_AUTHORS_FOR_FEED`, and truncation is logged at
 * `warn` — a limit nobody can see is a limit that gets blamed on something else.
 */
export const CHANNEL_NOTIFY_FANOUT_CAP = 5000;

/**
 * Handles a channel may not take, because they collide with a route segment, an
 * identity surface, or a support address somebody would be able to impersonate.
 *
 * Matched against the CANONICAL form (see {@link normalizeChannelHandle}), so the
 * list needs one spelling of each, not every casing of it.
 *
 * **`mine`, `invites` and `following` are load-bearing, not decorative.** The API
 * serves one channel at `GET /channels/:idOrHandle` on the PUBLIC router and the
 * caller-scoped lists at `GET /channels/mine` / `/invites` / `/following` on the
 * AUTHENTICATED one, and the public router is mounted first — so the param route
 * sees those segments before the lists do. It hands them on precisely because
 * they cannot name a channel, which is only true while they are reserved here.
 * Any future collection endpoint under `/channels` has to be added to this list
 * at the same time.
 */
export const RESERVED_CHANNEL_HANDLES: readonly string[] = [
  'admin',
  'administrator',
  'all',
  'api',
  'app',
  'channel',
  'channels',
  'compose',
  'explore',
  'feed',
  'feeds',
  'following',
  'help',
  'home',
  'invites',
  'list',
  'lists',
  'me',
  'mention',
  'messages',
  'mine',
  'moderator',
  'new',
  'notifications',
  'oxy',
  'root',
  'search',
  'settings',
  'staff',
  'support',
  'system',
  'trending',
  'undefined',
  'null',
];

/**
 * The ONE canonicalizer for a channel handle — the role `normalizeHashtag` plays
 * for tags. Every writer and every reader goes through it, so a route, a script
 * and a test cannot each arrive at a different spelling and quietly defeat the
 * unique index.
 *
 * Returns `null` for anything that is not a legal handle, so a caller cannot
 * accidentally treat an empty string as a valid one.
 */
export function normalizeChannelHandle(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^@/, '').toLowerCase();
  if (trimmed.length < CHANNEL_HANDLE_MIN_LENGTH) return null;
  if (trimmed.length > CHANNEL_HANDLE_MAX_LENGTH) return null;
  if (!/^[a-z0-9_]+$/.test(trimmed)) return null;
  if (RESERVED_CHANNEL_HANDLES.includes(trimmed)) return null;
  return trimmed;
}

/** A channel as its own page and its management screens read it. */
export interface Channel {
  id: string;
  /** Globally unique, canonical, and the `/c/<handle>` URL. */
  handle: string;
  title: string;
  description?: string;
  /** A bare Oxy file id, resolved by Bloom's `ImageResolver` — never a URL. */
  avatar?: string;
  /** A bare Oxy file id, resolved by Bloom's `ImageResolver` — never a URL. */
  banner?: string;
  ownerOxyUserId: string;
  visibility: ChannelVisibility;
  /**
   * Whether a channel post also names the person who wrote it.
   *
   * `false` (the default) means the post is ANONYMOUS behind the channel, and that
   * is enforced in the DTO, not in the UI: the real author does not travel at all.
   * Hiding it only in the renderer would leave it in the API response for anybody
   * who looked.
   */
  signPosts: boolean;
  followerCount: number;
  memberCount: number;
  postCount: number;
  createdAt: string;
  updatedAt: string;
  /** The caller's own relationship to the channel. Absent for anonymous readers. */
  viewerState?: ChannelViewerState;
}

/**
 * What a channel looks like ON A POST's DTO — the signature the row paints.
 *
 * Deliberately NOT a `PostUser`, and deliberately not convertible to one: Oxy owns
 * identity, and a channel is not a person. The renderer reads this field and
 * decides; nothing downstream may collapse the two shapes together.
 */
export interface ChannelSummary {
  id: string;
  handle: string;
  title: string;
  /** A bare Oxy file id, resolved by Bloom's `ImageResolver` — never a URL. */
  avatar?: string;
  /**
   * Whether the post's real author travels alongside this signature. When `false`
   * the DTO carries no author at all, so a client cannot render one even by
   * accident.
   */
  signPosts: boolean;
}

/** The caller's own relationship to a channel. */
export interface ChannelViewerState {
  isFollowing: boolean;
  /** Whether this follower wants notifications. Meaningless when not following. */
  notify: boolean;
  /** The caller's membership role, when they have one. */
  role?: ChannelMemberRole;
  /** The caller's membership status, when they have one. */
  memberStatus?: ChannelMemberStatus;
}

/** One membership row, with the member resolved through the canonical identity path. */
export interface ChannelMemberSummary {
  user: PostUser;
  role: ChannelMemberRole;
  status: ChannelMemberStatus;
  invitedAt?: string;
  respondedAt?: string;
}

export interface CreateChannelRequest {
  handle: string;
  title: string;
  description?: string;
  avatar?: string;
  banner?: string;
  signPosts?: boolean;
}

export interface UpdateChannelRequest {
  handle?: string;
  title?: string;
  description?: string;
  avatar?: string;
  banner?: string;
  signPosts?: boolean;
}

/** Body of `POST /channels/:id/members` — invite somebody to publish. */
export interface InviteChannelMemberRequest {
  oxyUserId: string;
}

/** Body of `PATCH /channels/:id/follow` — a follower's own notification switch. */
export interface UpdateChannelFollowRequest {
  notify: boolean;
}
