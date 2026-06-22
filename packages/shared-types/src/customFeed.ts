/**
 * Custom Feeds (user-created timelines)
 */

export const FEED_CATEGORIES = ['news', 'tech', 'culture', 'finance', 'health', 'sports', 'entertainment', 'other'] as const;
export type FeedCategory = typeof FEED_CATEGORIES[number];

export interface CustomFeed {
  id: string;
  _id?: string;
  ownerOxyUserId: string;
  title: string;
  description?: string;
  isPublic: boolean;
  memberOxyUserIds: string[]; // Accounts included in this feed
  sourceListIds?: string[]; // AccountList sources merged into this feed
  keywords?: string[];
  topicIds?: string[];
  includeReplies?: boolean;
  includeBoosts?: boolean;
  includeMedia?: boolean;
  language?: string;
  category?: FeedCategory;
  tags?: string[];
  coverImage?: string;
  subscriberCount?: number;
  averageRating?: number;
  ratingsCount?: number;
  /** Enriched on responses: total likes for this feed. */
  likeCount?: number;
  /** Enriched on responses: whether the requesting viewer liked this feed. */
  isLiked?: boolean;
  /** Enriched on responses: resolved member count. */
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomFeedRequest {
  title: string;
  description?: string;
  isPublic: boolean;
  memberOxyUserIds: string[];
  sourceListIds?: string[];
  keywords?: string[];
  topicIds?: string[];
  includeReplies?: boolean;
  includeBoosts?: boolean;
  includeMedia?: boolean;
  language?: string;
  category?: FeedCategory;
  tags?: string[];
  coverImage?: string;
}

export interface UpdateCustomFeedRequest {
  title?: string;
  description?: string;
  isPublic?: boolean;
  memberOxyUserIds?: string[];
  sourceListIds?: string[];
  keywords?: string[];
  topicIds?: string[];
  includeReplies?: boolean;
  includeBoosts?: boolean;
  includeMedia?: boolean;
  language?: string;
  category?: FeedCategory;
  tags?: string[];
  coverImage?: string;
}

export interface CustomFeedListResponse {
  items: CustomFeed[];
  total: number;
}
