/**
 * Profile-related types shared across Mention frontend and backend
 */

import type { PostUser } from './post';

export enum ProfileVisibility {
  PUBLIC = 'public',
  PRIVATE = 'private',
  FOLLOWERS_ONLY = 'followers_only',
}

export enum ProfileType {
  PERSONAL = 'personal',
  BUSINESS = 'business',
  CREATOR = 'creator',
  VERIFIED = 'verified',
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

export interface PrivacySettings {
  profileVisibility: ProfileVisibility;
  showContactInfo: boolean;
}

export interface ProfileSettings {
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
  boostsCount: number;
  repliesCount: number;
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
}

/**
 * What a REMOTE account's origin says about it: the ActivityPub actor's
 * `followers`/`following` collection `totalItems` and its `published` date, or
 * the atproto profile's counts. Served on the public profile-design DTO for a
 * federated account, and only there. Mention's own follow graph and the Oxy
 * account's `createdAt` describe the local mirror, which starts at zero on the
 * day Mention first discovered the account.
 *
 * Every field is ABSENT when the origin did not tell us, and a reader hides that
 * stat rather than rendering `0` or a date. The numbers are unverifiable by
 * construction — the remote's own claims about its own account.
 */
export interface RemoteProfileStats {
  followersCount?: number;
  followingCount?: number;
  /** The origin's post total (its outbox `totalItems`, or the atproto profile's count). */
  postsCount?: number;
  /** ISO 8601 — when the account was created on its origin. */
  joinedAt?: string;
  /** The account approves each follower (ActivityPub `manuallyApprovesFollowers`). */
  locked?: true;
  /** The account is kept in memory of someone who died (ActivityPub `memorial`). */
  memorial?: true;
  /**
   * The profile's metadata table (ActivityPub `PropertyValue` attachments), in
   * the order the profile lists them. Absent when it has none.
   */
  fields?: RemoteProfileField[];
  /**
   * Where the account moved, when it announced a verified `Move` to another
   * server. `handle` is the new account's `user@domain`, the handle its profile
   * route takes.
   */
  movedTo?: RemoteProfileMove;
}

/** One row of a remote profile's metadata table. */
export interface RemoteProfileField {
  name: string;
  /** Plain text: the remote HTML reduced to its text, each link to its URL. */
  value: string;
  /** ISO 8601 — when the origin verified the link in `value` (`rel="me"`). */
  verifiedAt?: string;
}

export interface RemoteProfileMove {
  handle: string;
  actorUri: string;
}

/**
 * One page of `GET /profile/connections/:userId/:kind` (`followers` | `following`):
 * the account's Oxy follow graph, then the remote edges mirrored from its origin
 * whose other end is an account known here. `nextCursor` is opaque. The origin's
 * totals are {@link RemoteProfileStats}, never the length of this list.
 */
export interface ProfileConnectionsPage {
  users: PostUser[];
  hasMore: boolean;
  nextCursor?: string;
}
