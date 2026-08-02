/**
 * `UserSettingsRecord` — the ONE shape a user's settings have once they leave
 * the database.
 *
 * ## Why this type moved here
 *
 * These interfaces were declared in `models/UserSettings.ts`, next to the
 * Mongoose schema. That was fine while Mongoose was the store; it is not fine
 * now, because the type every consumer depends on would keep its home in the
 * file the port exists to delete, and "import a type from the Mongoose model"
 * is how a deleted model comes back.
 *
 * The shape is deliberately UNCHANGED from what `UserSettingsData` described:
 * `extractPublicProfileData` and `buildSettingsResponseForViewer` build wire
 * DTOs straight off it, and the migration contract's hardest rule is that the
 * wire format does not change. So the nesting stays even though the table is
 * flat — the repository assembles it, exactly as `postRecord.ts` does for a
 * post's nine tables.
 *
 * ## The one structural difference from the Mongo document
 *
 * Mongo let every subdocument be ABSENT. Most of these columns are `NOT NULL`
 * with a default, so `appearance`, `privacy`, `profileCustomization`,
 * `notificationPreferences` and `feedSettings` are always present on a loaded
 * record. That removes the "is the subdoc there at all?" branch every reader
 * carried — and it is why a reader must not treat absence as "unset": a user
 * who never opened settings now reads back the DEFAULTS, which is what the
 * Mongoose schema's own defaults produced anyway.
 */

import type { ExternalEmbedsSettings, FeedTuning } from '@mention/shared-types';

export type ThemeMode = 'light' | 'dark' | 'system' | 'adaptive';

/**
 * How much of a post's body text shows before truncating with a "read more"
 * link in feeds. Mention-only display preference applied client-side. `all`
 * disables in-feed truncation entirely.
 */
export type PostTextExpand = 'default' | 'more' | 'muchMore' | 'all';

/** Behavior when tapping a truncated post's "Read more" link. */
export type PostReadMoreAction = 'openPost' | 'expandInline';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
  postTextExpand?: PostTextExpand;
  postReadMoreAction?: PostReadMoreAction;
  collapseLongBio?: boolean;
}

export interface LabelAction {
  labelerId: string;
  labelSlug: string;
  action: 'hide' | 'warn' | 'blur' | 'show';
}

export interface LabelPreferences {
  subscribedLabelers: string[];
  labelActions: LabelAction[];
}

export interface PrivacySettings {
  profileVisibility: 'public' | 'private' | 'followers_only';
  showContactInfo?: boolean;
  allowTags?: boolean;
  allowMentions?: boolean;
  showOnlineStatus?: boolean;
  hideLikeCounts?: boolean;
  hideShareCounts?: boolean;
  hideReplyCounts?: boolean;
  hideSaveCounts?: boolean;
  /**
   * Whether the viewer opts IN to seeing sensitive / NSFW content in discovery
   * surfaces (For You, Explore) and ranked feeds. Default `false` keeps every
   * feed safe-for-work; when `true` the centralized sensitivity gate is relaxed
   * for this viewer so flagged posts surface (still carrying their sensitive flag
   * so clients can blur / show a content warning).
   */
  showSensitiveContent?: boolean;
  hiddenWords?: string[];
  restrictedUsers?: string[];
  labelPreferences?: LabelPreferences;
}

/**
 * A Syra track pinned to the profile (Instagram-style "profile song"). The
 * metadata is denormalized server-side from the canonical Syra catalog at save
 * time (never trusted from the client) so viewers can render the song row and
 * play its 30s preview without a round-trip to Syra.
 */
export interface ProfileMediaSong {
  type: 'song';
  syraTrackId: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  previewUrl: string;
  startSec: number;
  durationSec?: number;
}

/**
 * A Syra podcast SHOW pinned to the profile. Like {@link ProfileMediaSong}, the
 * metadata is denormalized server-side from the canonical Syra catalog at save
 * time (never trusted from the client) so viewers can render the show card and
 * deep-link into the Syra app without a round-trip to Syra.
 */
export interface ProfileMediaPodcast {
  type: 'podcast';
  syraPodcastId: string;
  title: string;
  author?: string;
  artworkUrl?: string;
  showUrl: string;
}

/**
 * The single media item pinned to a profile — EITHER a song OR a podcast show,
 * never both. The two shapes are discriminated by `type`; storing one
 * automatically replaces the other (this is the mutual exclusion).
 *
 * Both variants share one set of columns, so the discriminator is the ONLY
 * thing that says which of them the row holds. A reader that inspects
 * `syraTrackId` instead of `type` sees a stale song's leftovers on a row that
 * now holds a podcast.
 */
export type ProfileMedia = ProfileMediaSong | ProfileMediaPodcast;

export interface ProfileCustomization {
  coverPhotoEnabled?: boolean;
  minimalistMode?: boolean;
  profileMedia?: ProfileMedia | null;
}

export interface InterestsSettings {
  tags?: string[];
}

export interface NotificationPreferences {
  pushEnabled: boolean;
  emailEnabled: boolean;
  likes: boolean;
  boosts: boolean;
  follows: boolean;
  mentions: boolean;
  replies: boolean;
  quotes: boolean;
}

export interface FeedSettings {
  diversity: {
    enabled: boolean;
    sameAuthorPenalty: number;
    sameTopicPenalty: number;
    maxConsecutiveSameAuthor?: number;
  };
  recency: {
    halfLifeHours: number;
    maxAgeHours: number;
  };
  quality: {
    minEngagementRate?: number;
    boostHighQuality: boolean;
  };
}

/** A user's settings, assembled. */
export interface UserSettingsRecord {
  oxyUserId: string;
  appearance: AppearanceSettings;
  profileHeaderImage?: string;
  privacy: PrivacySettings;
  profileCustomization: ProfileCustomization;
  interests?: InterestsSettings;
  feedSettings: FeedSettings;
  /**
   * Mention-local per-user FEED TUNING — the viewer's overrides on their OWN
   * For You discovery gate. NOT stored in Oxy: this is feed-behavior tuning,
   * not identity. Validated against the shared `FOR_YOU_TUNING_MODULES` spec on
   * write, so the columns only round-trip the shape.
   */
  feedTuning?: FeedTuning;
  notificationPreferences: NotificationPreferences;
  /**
   * Per-provider preference for whether third-party media embeds auto-load
   * their inline player. Absent providers default to "ask on first play".
   */
  externalEmbeds?: ExternalEmbedsSettings;
  /**
   * The user's global default "primary" post language — a canonical BCP-47 tag.
   * Mention-owned (NOT an Oxy identity field): it seeds the composer's default
   * primary language variant client-side.
   */
  fediversePreferredLanguage?: string;
  createdAt: Date;
  updatedAt: Date;
}
