import mongoose, { Schema, Document } from 'mongoose';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  primaryColor?: string;
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
  hiddenWords?: string[];
  restrictedUsers?: string[]; // Users who can see limited content
}

export interface ProfileCustomization {
  coverPhotoEnabled?: boolean;
  minimalistMode?: boolean;
  displayName?: string; // Custom display name (overrides Oxy profile name)
  coverImage?: string; // Custom cover image (alternative to profileHeaderImage)
}

export interface InterestsSettings {
  tags?: string[]; // Array of interest tags
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

export interface IUserSettings extends Document {
  oxyUserId: string;
  appearance: AppearanceSettings;
  profileHeaderImage?: string;
  privacy?: PrivacySettings;
  profileCustomization?: ProfileCustomization;
  interests?: InterestsSettings;
  feedSettings?: FeedSettings;
  createdAt: Date;
  updatedAt: Date;
}

const AppearanceSchema = new Schema<AppearanceSettings>({
  themeMode: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
  primaryColor: { type: String, default: undefined },
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
  hiddenWords: [{ type: String }],
  restrictedUsers: [{ type: String }],
}, { _id: false });

const ProfileCustomizationSchema = new Schema<ProfileCustomization>({
  coverPhotoEnabled: { type: Boolean, default: true },
  minimalistMode: { type: Boolean, default: false },
  displayName: { type: String },
  coverImage: { type: String },
}, { _id: false });

const InterestsSchema = new Schema<InterestsSettings>({
  tags: [{ type: String }],
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
}, { timestamps: true, versionKey: false });

export const UserSettings = mongoose.model<IUserSettings>('UserSettings', UserSettingsSchema);

export default UserSettings;

