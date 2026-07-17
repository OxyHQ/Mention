import { authenticatedClient } from '@/utils/api';
import type {
  CreateCustomFeedRequest,
  CustomFeed,
  CustomFeedListResponse,
  FeedResponse,
  PostUser,
  UpdateCustomFeedRequest,
} from '@mention/shared-types';
import { logger } from '@/lib/logger';
import { normalizeApiError } from '@/utils/apiError';

interface CustomFeedListParams {
  mine?: boolean;
  publicOnly?: boolean;
  search?: string;
  userId?: string;
}

/**
 * A `CustomFeed` as returned by `GET /feeds/marketplace`, which enriches each
 * item with a resolved owner summary, the viewer's `isLiked` (subscribed) flag,
 * and derived member/topic counts. `memberAvatars` is only populated by the
 * `GET /feeds` list route, so it stays optional here.
 */
export type MarketplaceFeed = CustomFeed & {
  owner?: { username?: string; displayName?: string; avatar?: string };
  memberAvatars?: string[];
  topicCount?: number;
};

/** `GET /feeds/marketplace` — a {@link CustomFeedListResponse} of enriched items. */
export interface MarketplaceListResponse extends CustomFeedListResponse {
  items: MarketplaceFeed[];
}

/**
 * A `CustomFeed` as returned by `GET /feeds/:id`, which additionally resolves the
 * owner and the member accounts. Both are the canonical Oxy user shape (Oxy owns
 * identity), so the display name lives at `name.displayName` — never a flat
 * `displayName` field.
 *
 * `isLiked` / `likeCount` carry the viewer's subscription and the feed's
 * subscriber tally: a subscription IS a `FeedLike` row (`POST /feeds/:id/like`),
 * the same records the marketplace reads.
 */
export type CustomFeedDetail = CustomFeed & {
  owner?: PostUser | null;
  members?: PostUser[];
  memberAvatars?: string[];
  topicCount?: number;
};

/** A type alias, not an interface: the HTTP client's `params` takes a `Record`. */
type MarketplaceParams = {
  category?: string;
  search?: string;
  sortBy?: string;
  page?: number;
  limit?: number;
  /**
   * Drop the feeds the viewer already has — their own feeds and the ones they
   * subscribed to. Recommendation surfaces must never suggest what the viewer
   * is already reading. Ignored for anonymous viewers (they subscribe to none).
   */
  excludeSubscribed?: boolean;
};

/**
 * One review as returned by `GET /feeds/:id/reviews`. The reviewer is the
 * canonical Oxy user (display name at `name.displayName`), resolved server-side
 * through the same batched summary cache post hydration uses.
 */
export interface CustomFeedReview {
  id: string;
  _id?: string;
  rating: number;
  reviewText?: string;
  createdAt?: string;
  reviewer?: PostUser;
}

export interface FeedReviewsResponse {
  reviews: CustomFeedReview[];
  total: number;
  page: number;
  totalPages: number;
}

/** One marketplace category and how many public feeds sit in it. */
export interface FeedCategoryCount {
  category: string;
  count: number;
}

/**
 * A FEED GENERATOR as returned by `GET /feeds/generators` — a third-party /
 * algorithmic feed (today a Bluesky feed mirrored into a native `FeedGenerator`).
 * It is opened through the MTN feed engine via its `descriptor` (`feedgen|<uri>`),
 * NOT the CustomFeed detail screen, and imports the remote algorithm's output as
 * native posts. Read-only + owned upstream.
 */
export interface FeedGeneratorItem {
  id: string;
  uri: string;
  /** The MTN feed descriptor that opens this generator: `feedgen|<uri>`. */
  descriptor: string;
  title: string;
  description?: string;
  avatar?: string;
  likeCount: number;
  owner?: PostUser | null;
}

export interface FeedGeneratorListResponse {
  items: FeedGeneratorItem[];
  total: number;
}

interface FeedLikeResponse {
  success: boolean;
  liked: boolean;
  likeCount: number;
}

/**
 * Run a custom-feeds request, logging and rethrowing (with the original error
 * preserved as `cause`) on failure. Centralizes error handling so every method
 * fails loud instead of silently — without altering happy-path return shapes.
 */
async function run<T>(operation: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const normalized = normalizeApiError(error);
    logger.error(`customFeedsService.${operation} failed`, {
      status: normalized.status,
      code: normalized.code,
      message: normalized.message,
    });
    throw new Error(normalized.message, { cause: error });
  }
}

class CustomFeedsService {
  async list(params?: CustomFeedListParams): Promise<CustomFeedListResponse> {
    return run('list', async () => {
      const res = await authenticatedClient.get<CustomFeedListResponse>('/feeds', { params: { ...params } });
      return res.data;
    });
  }

  async get(id: string): Promise<CustomFeedDetail> {
    return run('get', async () => {
      const res = await authenticatedClient.get<CustomFeedDetail>(`/feeds/${id}`);
      return res.data;
    });
  }

  /**
   * List a user's FEED GENERATORS — third-party/algorithmic feeds keyed on the
   * owner (`createdBy`). Today these are synced Bluesky feeds, so a federated
   * profile's mirrored feeds surface on its Feeds tab alongside native custom feeds.
   * Each carries a `descriptor` (`feedgen|<uri>`) to open it through the MTN engine.
   */
  async listGenerators(params?: { userId?: string; mine?: boolean }): Promise<FeedGeneratorListResponse> {
    return run('listGenerators', async () => {
      const res = await authenticatedClient.get<FeedGeneratorListResponse>('/feeds/generators', { params: { ...params } });
      return res.data;
    });
  }

  async create(req: CreateCustomFeedRequest): Promise<CustomFeed> {
    return run('create', async () => {
      const res = await authenticatedClient.post<CustomFeed>('/feeds', req);
      return res.data;
    });
  }

  async update(id: string, req: UpdateCustomFeedRequest): Promise<CustomFeed> {
    return run('update', async () => {
      const res = await authenticatedClient.put<CustomFeed>(`/feeds/${id}`, req);
      return res.data;
    });
  }

  async remove(id: string): Promise<{ success: boolean }> {
    return run('remove', async () => {
      const res = await authenticatedClient.delete<{ success: boolean }>(`/feeds/${id}`);
      return res.data;
    });
  }

  async addMembers(id: string, userIds: string[]): Promise<CustomFeed> {
    return run('addMembers', async () => {
      const res = await authenticatedClient.post<CustomFeed>(`/feeds/${id}/members`, { userIds });
      return res.data;
    });
  }

  async removeMembers(id: string, userIds: string[]): Promise<CustomFeed> {
    return run('removeMembers', async () => {
      const res = await authenticatedClient.delete<CustomFeed>(`/feeds/${id}/members`, { data: { userIds } });
      return res.data;
    });
  }

  async getTimeline(id: string, params?: { cursor?: string; limit?: number }): Promise<FeedResponse> {
    return run('getTimeline', async () => {
      const res = await authenticatedClient.get<FeedResponse>(`/feeds/${id}/timeline`, { params });
      return res.data;
    });
  }

  async likeFeed(id: string): Promise<FeedLikeResponse> {
    return run('likeFeed', async () => {
      const res = await authenticatedClient.post<FeedLikeResponse>(`/feeds/${id}/like`);
      return res.data;
    });
  }

  async unlikeFeed(id: string): Promise<FeedLikeResponse> {
    return run('unlikeFeed', async () => {
      const res = await authenticatedClient.delete<FeedLikeResponse>(`/feeds/${id}/like`);
      return res.data;
    });
  }

  async getMarketplace(params?: MarketplaceParams): Promise<MarketplaceListResponse> {
    return run('getMarketplace', async () => {
      const res = await authenticatedClient.get<MarketplaceListResponse>('/feeds/marketplace', { params });
      return res.data;
    });
  }

  async getMarketplaceCategories(): Promise<{ categories: FeedCategoryCount[] }> {
    return run('getMarketplaceCategories', async () => {
      const res = await authenticatedClient.get<{ categories: FeedCategoryCount[] }>('/feeds/marketplace/categories');
      return res.data;
    });
  }

  async getReviews(feedId: string, params?: { page?: number; limit?: number }): Promise<FeedReviewsResponse> {
    return run('getReviews', async () => {
      const res = await authenticatedClient.get<FeedReviewsResponse>(`/feeds/${feedId}/reviews`, { params });
      return res.data;
    });
  }

  async submitReview(feedId: string, data: { rating: number; reviewText?: string }): Promise<unknown> {
    return run('submitReview', async () => {
      const res = await authenticatedClient.post<unknown>(`/feeds/${feedId}/reviews`, data);
      return res.data;
    });
  }
}

export const customFeedsService = new CustomFeedsService();
