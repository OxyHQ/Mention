export interface UserSession {
  id: string;
  accessToken: string;
  refreshToken?: string;
  lastRefresh: number;
  profile?: OxyProfile;
}

export interface OxyProfile {
  _id?: string;
  userID: string;
  name?: {
    first?: string;
    last?: string;
  };
  username: string;
  email: string;
  privacySettings?: {
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
  };
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
}