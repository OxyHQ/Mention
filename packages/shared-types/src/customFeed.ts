/**
 * Custom Feeds (user-created timelines)
 */

export interface CustomFeed {
  id: string;
  _id?: string;
  ownerOxyUserId: string;
  title: string;
  description?: string;
  isPublic: boolean;
  memberOxyUserIds: string[]; // Accounts included in this feed
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomFeedRequest {
  title: string;
  description?: string;
  isPublic: boolean;
  memberOxyUserIds: string[];
}

export interface UpdateCustomFeedRequest {
  title?: string;
  description?: string;
  isPublic?: boolean;
  memberOxyUserIds?: string[];
}

export interface CustomFeedListResponse {
  items: CustomFeed[];
  total: number;
}

