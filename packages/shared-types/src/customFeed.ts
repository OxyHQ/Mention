/**
 * Custom Feeds (user-created timelines)
 */

export const FEED_CATEGORIES = ['news', 'tech', 'culture', 'finance', 'health', 'sports', 'entertainment', 'other'] as const;
export type FeedCategory = typeof FEED_CATEGORIES[number];

/** The two execution modes a composable feed definition can run in. */
export type FeedDefinitionMode = 'ranked' | 'chronological';

/**
 * A single toggleable, parameterized module reference inside a stored feed
 * definition. Mirrors the backend engine's `ModuleRef`; the wire contract shared
 * by the custom-feed builder, the write endpoints, and the engine.
 */
export interface FeedModuleRef {
  module: string;
  enabled: boolean;
  params?: Record<string, unknown>;
  weight?: number;
}

/**
 * The composable definition a custom feed stores and the FeedEngine runs: a
 * `mode` plus the sources / signals / filters module lists. This is exactly the
 * body the builder submits under `definition` and what the backend validates.
 */
export interface FeedDefinitionInput {
  mode: FeedDefinitionMode;
  sources: FeedModuleRef[];
  signals: FeedModuleRef[];
  filters: FeedModuleRef[];
}

export interface CustomFeed {
  id: string;
  _id?: string;
  ownerOxyUserId: string;
  title: string;
  description?: string;
  isPublic: boolean;
  /** The composable definition the FeedEngine runs (Phase 3). */
  definition?: FeedDefinitionInput;
  /** Lucide icon name shown in the feeds screen / builder. */
  icon?: string;
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

/** Visibility choice surfaced in the builder; maps to `isPublic` server-side. */
export type FeedVisibility = 'public' | 'private';

export interface CreateCustomFeedRequest {
  title: string;
  description?: string;
  visibility?: FeedVisibility;
  icon?: string;
  definition: FeedDefinitionInput;
}

export interface UpdateCustomFeedRequest {
  title?: string;
  description?: string;
  visibility?: FeedVisibility;
  icon?: string;
  definition?: FeedDefinitionInput;
}

export interface CustomFeedListResponse {
  items: CustomFeed[];
  total: number;
}
