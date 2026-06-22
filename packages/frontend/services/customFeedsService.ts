import { authenticatedClient } from '@/utils/api';
import type {
  CreateCustomFeedRequest,
  CustomFeed,
  CustomFeedListResponse,
  FeedResponse,
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

interface FeedReviewsResponse {
  reviews: unknown[];
  total: number;
  page: number;
  totalPages: number;
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

  async get(id: string): Promise<CustomFeed> {
    return run('get', async () => {
      const res = await authenticatedClient.get<CustomFeed>(`/feeds/${id}`);
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

  async getMarketplace(params?: { category?: string; search?: string; sortBy?: string; page?: number; limit?: number }): Promise<CustomFeedListResponse> {
    return run('getMarketplace', async () => {
      const res = await authenticatedClient.get<CustomFeedListResponse>('/feeds/marketplace', { params });
      return res.data;
    });
  }

  async getMarketplaceCategories(): Promise<{ categories: Array<{ category: string; count: number }> }> {
    return run('getMarketplaceCategories', async () => {
      const res = await authenticatedClient.get<{ categories: Array<{ category: string; count: number }> }>('/feeds/marketplace/categories');
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
