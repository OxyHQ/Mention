export * from './Profile';

export interface UserSession {
  id: string;
  username: string;
  accessToken: string;
  refreshToken?: string;
  lastRefresh: number;
}

export interface OxyProfile {
  userID: string;
  name?: {
    first?: string;
    last?: string;
  };
  username: string;
  email: string;
  privacySettings?: PrivacySettings;
  avatar?: string;
  coverPhoto?: string;
  location?: string;
  website?: string;
  description?: string;
  _count?: {
    followers: number;
    following: number;
    posts: number;
    karma: number;
  };
  createdAt?: string;
}

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