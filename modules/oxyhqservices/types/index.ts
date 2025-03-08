/**
 * OxyHQ Services Types
 * 
 * Core type definitions used throughout the OxyHQ services module.
 */

/**
 * Extended user session with authentication tokens and profile data
 */
export interface ExtendedUserSession {
  id: string;
  accessToken: string;
  refreshToken?: string;
  lastRefresh: number;
  profile?: OxyProfile;
}

/**
 * Privacy settings for a user profile
 */
export interface PrivacySettings {
  isPrivateAccount: boolean;
  hideOnlineStatus: boolean;
  hideLastSeen: boolean;
  profileVisibility: boolean;
  postVisibility: boolean;
  twoFactorEnabled: boolean;
  loginAlerts: boolean;
  blockScreenshots: boolean;
  secureLogin: boolean;
  biometricLogin: boolean;
  showActivity: boolean;
  allowTagging: boolean;
  allowMentions: boolean;
  hideReadReceipts: boolean;
  allowComments: boolean;
  allowDirectMessages: boolean;
  dataSharing: boolean;
  locationSharing: boolean;
  analyticsSharing: boolean;
  sensitiveContent: boolean;
  autoFilter: boolean;
  muteKeywords: boolean;
}

/**
 * Full user profile from the OxyHQ platform
 */
export interface OxyProfile {
  _id?: string;
  userID: string;
  name?: {
    first?: string;
    last?: string;
  };
  username: string;
  email: string;
  privacySettings?: PrivacySettings;
  avatar?: string;
  labels?: string[];
  description?: string;
  coverPhoto?: string;
  location?: string;
  website?: string;
  pinnedPost?: {
    cid?: string;
    uri?: string;
  };
  _count?: {
    followers: number;
    following: number;
    posts: number;
    karma: number;
  };
  createdAt?: string;
  updatedAt?: string;
  premium?: {
    isPremium: boolean;
    subscriptionStatus?: string;
    subscriptionTier?: string;
    startDate?: string;
    endDate?: string;
    features?: {
      analyticsSharing?: boolean;
      customThemes?: boolean;
      prioritySupport?: boolean;
      maxProjects?: number;
      storageLimit?: number;
      [key: string]: any;
    };
    paymentHistory?: Array<{
      transactionId: string;
      amount: number;
      date: string;
      status: string;
      provider: string;
      plan: string;
    }>;
  };
  stats?: {
    followers: number;
    following: number;
    posts: number;
    karma: number;
  };
  associated?: {
    feedgens?: number;
    labeler?: boolean;
    lists?: number;
    starterPacks?: number;
    [key: string]: any;
  };
  bookmarks?: string[];
  followers?: any[];
  following?: any[];
  pinnedPosts?: any[];
}

/**
 * Subscription plan types
 */
export type SubscriptionPlan = 'basic' | 'pro' | 'business';

/**
 * Subscription features
 */
export interface SubscriptionFeatures {
  analytics: boolean;
  premiumBadge: boolean;
  unlimitedFollowing: boolean;
  higherUploadLimits: boolean;
  promotedPosts: boolean;
  businessTools: boolean;
}

/**
 * Authentication response error with field-specific validation details
 */
export interface AuthError {
  message: string;
  details?: Record<string, string>;
}