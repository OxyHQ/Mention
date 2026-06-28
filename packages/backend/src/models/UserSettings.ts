import mongoose, { Schema, Document } from 'mongoose';

export type ThemeMode = 'light' | 'dark' | 'system' | 'adaptive';

/**
 * How much of a post's body text shows before truncating with a "read more"
 * link in feeds. Mention-only display preference applied client-side. `all`
 * disables in-feed truncation entirely.
 */
export type PostTextExpand = 'default' | 'more' | 'muchMore' | 'all';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
  postTextExpand?: PostTextExpand;
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
  restrictedUsers?: string[]; // Users who can see limited content
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
 */
export type ProfileMedia = ProfileMediaSong | ProfileMediaPodcast;

export interface ProfileCustomization {
  coverPhotoEnabled?: boolean;
  minimalistMode?: boolean;
  profileMedia?: ProfileMedia | null;
}

export interface InterestsSettings {
  tags?: string[]; // Array of interest tags
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
    sameAuthorPenalty: number; // 0.5 - 1.0
    sameTopicPenalty: number; // 0.5 - 1.0
    maxConsecutiveSameAuthor?: number; // Max posts from same author in a row
  };
  recency: {
    halfLifeHours: number; // 6 - 72 hours
    maxAgeHours: number; // 24 - 336 hours (14 days)
  };
  quality: {
    minEngagementRate?: number; // Minimum engagement rate threshold
    boostHighQuality: boolean;
  };
}

export interface UserSettingsData {
  oxyUserId: string;
  appearance: AppearanceSettings;
  profileHeaderImage?: string;
  privacy?: PrivacySettings;
  profileCustomization?: ProfileCustomization;
  interests?: InterestsSettings;
  feedSettings?: FeedSettings;
  notificationPreferences?: NotificationPreferences;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserSettings extends UserSettingsData, Document {}

const AppearanceSchema = new Schema<AppearanceSettings>({
  themeMode: { type: String, enum: ['light', 'dark', 'system', 'adaptive'], default: 'system' },
  primaryColor: { type: String, default: undefined },
  postTextExpand: { type: String, enum: ['default', 'more', 'muchMore', 'all'], default: 'default' },
}, { _id: false });

const LabelActionSchema = new Schema<LabelAction>({
  labelerId: { type: String, required: true },
  labelSlug: { type: String, required: true },
  action: { type: String, enum: ['hide', 'warn', 'blur', 'show'], required: true },
}, { _id: false });

const LabelPreferencesSchema = new Schema<LabelPreferences>({
  subscribedLabelers: [{ type: String }],
  labelActions: { type: [LabelActionSchema], default: [] },
}, { _id: false });

const PrivacySchema = new Schema<PrivacySettings>({
  profileVisibility: { type: String, enum: ['public', 'private', 'followers_only'], default: 'public' },
  showContactInfo: { type: Boolean, default: true },
  allowTags: { type: Boolean, default: true },
  allowMentions: { type: Boolean, default: true },
  showOnlineStatus: { type: Boolean, default: true },
  hideLikeCounts: { type: Boolean, default: false },
  hideShareCounts: { type: Boolean, default: false },
  hideReplyCounts: { type: Boolean, default: false },
  hideSaveCounts: { type: Boolean, default: false },
  showSensitiveContent: { type: Boolean, default: false },
  hiddenWords: [{ type: String }],
  restrictedUsers: [{ type: String }],
  labelPreferences: { type: LabelPreferencesSchema },
}, { _id: false });

// One denormalized sub-schema holds BOTH media shapes; `type` discriminates and
// the type-specific fields are individually optional (each shape is validated +
// fully resolved server-side before it is written, so the schema only needs to
// round-trip whichever shape was persisted). Storing one shape overwrites the
// other because it is a single field.
const ProfileMediaSchema = new Schema({
  type: { type: String, enum: ['song', 'podcast'], required: true },
  // Shared
  title: { type: String, required: true },
  artworkUrl: { type: String },
  // Song-only
  syraTrackId: { type: String },
  artist: { type: String },
  previewUrl: { type: String },
  startSec: { type: Number },
  durationSec: { type: Number },
  // Podcast-only
  syraPodcastId: { type: String },
  author: { type: String },
  showUrl: { type: String },
}, { _id: false });

const ProfileCustomizationSchema = new Schema<ProfileCustomization>({
  coverPhotoEnabled: { type: Boolean, default: true },
  minimalistMode: { type: Boolean, default: false },
  profileMedia: { type: ProfileMediaSchema, default: null },
}, { _id: false });

const InterestsSchema = new Schema<InterestsSettings>({
  tags: [{ type: String }],
}, { _id: false });

const NotificationPreferencesSchema = new Schema<NotificationPreferences>({
  pushEnabled: { type: Boolean, default: true },
  emailEnabled: { type: Boolean, default: false },
  likes: { type: Boolean, default: true },
  boosts: { type: Boolean, default: true },
  follows: { type: Boolean, default: true },
  mentions: { type: Boolean, default: true },
  replies: { type: Boolean, default: true },
  quotes: { type: Boolean, default: true },
}, { _id: false });

const FeedSettingsSchema = new Schema<FeedSettings>({
  diversity: {
    enabled: { type: Boolean, default: true },
    sameAuthorPenalty: { type: Number, default: 0.95, min: 0.5, max: 1.0 },
    sameTopicPenalty: { type: Number, default: 0.92, min: 0.5, max: 1.0 },
    maxConsecutiveSameAuthor: { type: Number, min: 1, max: 10 },
  },
  recency: {
    halfLifeHours: { type: Number, default: 24, min: 6, max: 72 },
    maxAgeHours: { type: Number, default: 168, min: 24, max: 336 },
  },
  quality: {
    minEngagementRate: { type: Number, min: 0, max: 1 },
    boostHighQuality: { type: Boolean, default: true },
  },
}, { _id: false });

const UserSettingsSchema = new Schema<IUserSettings>({
  oxyUserId: { type: String, required: true, index: true, unique: true },
  appearance: { type: AppearanceSchema, default: () => ({ themeMode: 'system' }) },
  profileHeaderImage: { type: String },
  privacy: { type: PrivacySchema, default: () => ({ profileVisibility: 'public' }) },
  profileCustomization: { type: ProfileCustomizationSchema },
  interests: { type: InterestsSchema },
  feedSettings: { type: FeedSettingsSchema },
  notificationPreferences: { type: NotificationPreferencesSchema },
}, { timestamps: true, versionKey: false });

export const UserSettings = mongoose.model<IUserSettings>('UserSettings', UserSettingsSchema);

export default UserSettings;
