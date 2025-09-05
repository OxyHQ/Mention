/**
 * Profile-related types shared across Mention frontend and backend
 */

import {
  Timestamps
} from './common';

export enum ProfileVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
  FOLLOWERS_ONLY = 'followers_only'
}

export enum ProfileType {
  PERSONAL = 'personal',
  BUSINESS = 'business',
  CREATOR = 'creator',
  VERIFIED = 'verified'
}

export interface PersonalInfo {
  bio?: string;
  displayName?: string;
  username: string;
  avatar?: string;
  banner?: string;
  location?: string;
  website?: string;
  birthDate?: string;
}

export interface ProfileNotificationSettings {
  email: boolean;
  push: boolean;
  sms: boolean;
  postNotifications?: boolean;
  mentionNotifications?: boolean;
  followNotifications?: boolean;
  likeNotifications?: boolean;
  repostNotifications?: boolean;
}

export interface PrivacySettings {
  profileVisibility: ProfileVisibility;
  showContactInfo: boolean;
}

export interface ProfileSettings {
  notifications: ProfileNotificationSettings;
  privacy: PrivacySettings;
  language: string;
  timezone: string;
  currency?: string;
  /** Optional appearance settings (theme, colors) */
  appearance?: AppearanceSettings;
}

export interface ProfileStats {
  postsCount: number;
  followersCount: number;
  followingCount: number;
  likesCount: number;
  repostsCount: number;
}

export interface Profile {
  id: string;
  _id?: string;
  oxyUserId: string;
  profileType: ProfileType;
  isPrimary: boolean;
  isActive: boolean;
  personalInfo: PersonalInfo;
  settings: ProfileSettings;
  stats: ProfileStats;
  createdAt: string;
  updatedAt: string;
}

// Oxy User Integration
export interface OxyUser {
  id: string;
  email: string;
  name: string;
  avatar?: string;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileWithOxyUser {
  profile: Profile;
  oxyUser: OxyUser;
}

// Appearance / Theme
export type ThemeMode = 'light' | 'dark' | 'system';

export interface AppearanceSettings {
  /** Preferred app theme */
  themeMode: ThemeMode;
  /** User-selected primary color in hex (e.g. #005c67) */
  primaryColor?: string;
}
