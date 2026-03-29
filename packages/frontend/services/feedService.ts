import {
  FeedRequest,
  FeedResponse,
  SlicedFeedResponse,
  CreateReplyRequest,
  CreateRepostRequest,
  CreatePostRequest,
  CreateThreadRequest,
  LikeRequest,
  UnlikeRequest,
  FeedType,
  FeedDescriptor,
  isValidFeedDescriptor,
} from '@mention/shared-types';

// Feed responses may include slices for thread grouping
type FeedServiceResponse = FeedResponse & Partial<Pick<SlicedFeedResponse, 'slices'>>;
import { FeedFilters } from '../utils/feedUtils';
import { authenticatedClient, publicClient } from '../utils/api';
import { logger } from '@/lib/logger';

// Extended FeedRequest with frontend-specific filter properties
interface ExtendedFeedRequest extends Omit<FeedRequest, 'filters'> {
  filters?: FeedFilters;
  sort?: string;
}

// Helper function to make unauthenticated requests using publicClient
const makePublicRequest = async (endpoint: string, params?: Record<string, any>): Promise<any> => {
  try {
    const response = await publicClient.get(endpoint, { params });
    return response.data;
  } catch (error: any) {
    const message = error?.response?.data?.message || error?.message || `HTTP error! status: ${error?.response?.status}`;
    throw new Error(message);
  }
};

interface FeedServiceOptions {
  signal?: AbortSignal;
  skipCache?: boolean;
}

interface CachedFeedResponse {
  data: FeedServiceResponse;
  timestamp: number;
  expiresAt: number;
}

// Client-side cache for feed responses (L3 cache - 2-5 minutes TTL for initial loads)
const feedCache = new Map<string, CachedFeedResponse>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes for initial loads (increased from 30s)
const CACHE_TTL_PAGINATION_MS = 30 * 1000; // 30 seconds for pagination requests

// Generate stable cache key from request (avoids JSON.stringify key-order instability)
function getCacheKey(request: ExtendedFeedRequest): string {
  const filters = request.filters;
  const filterKey = filters
    ? Object.keys(filters).sort().map((k) => `${k}=${(filters as any)[k] ?? ''}`).join('&')
    : '';
  return `${request.type || 'mixed'}|${request.cursor || 'initial'}|${request.userId || ''}|${request.sort || ''}|${filterKey}`;
}

// Clean up expired cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, cached] of feedCache.entries()) {
    if (now > cached.expiresAt) {
      feedCache.delete(key);
    }
  }
}, 60000); // Clean up every minute

// In-flight request deduplication
const inFlightRequests = new Map<string, Promise<FeedServiceResponse>>();

class FeedService {
  /**
   * Get feed data from backend using Oxy authenticated client
   * Includes client-side caching for 30 seconds to reduce redundant requests
   */
  async getFeed(request: ExtendedFeedRequest, options?: FeedServiceOptions): Promise<FeedServiceResponse> {
      // Check cache first (only for non-cursor requests to avoid stale pagination)
      if (!request.cursor && !options?.skipCache) {
        const cacheKey = getCacheKey(request);
        const cached = feedCache.get(cacheKey);
        if (cached && Date.now() < cached.expiresAt) {
          logger.debug('[FeedService] Cache hit', { type: request.type });
          return cached.data;
        }
      }

      // Deduplicate in-flight requests
      const dedupeKey = options?.skipCache ? undefined : getCacheKey(request);
      if (dedupeKey) {
        const inFlight = inFlightRequests.get(dedupeKey);
        if (inFlight) {
          return inFlight;
        }
      }

      const fetchPromise = (async () => {
        try {

          // Handle hashtag feed — dedicated endpoint
          if (request.type === 'hashtag' && request.filters?.hashtag) {
            const tag = encodeURIComponent(request.filters.hashtag);
            const tagParams: any = {};
            if (request.cursor) tagParams.cursor = request.cursor;
            if (request.limit) tagParams.limit = request.limit;

            const response = await authenticatedClient.get(`/posts/hashtag/${tag}`, {
              params: tagParams,
              signal: options?.signal,
            });
            return response.data;
          }

          // Handle topic feed — dedicated endpoint
          if (request.type === 'topic' && request.filters?.topic) {
            const topic = encodeURIComponent(request.filters.topic);
            const topicParams: any = {};
            if (request.cursor) topicParams.cursor = request.cursor;
            if (request.limit) topicParams.limit = request.limit;

            const response = await authenticatedClient.get(`/posts/topic/${topic}`, {
              params: topicParams,
              signal: options?.signal,
            });
            return response.data;
          }

          // Handle custom feed type - use dedicated timeline endpoint (backend-driven)
          if (request.type === 'custom' && request.filters?.customFeedId) {
            const feedId = request.filters.customFeedId;
            const timelineParams: any = {};
            if (request.cursor) timelineParams.cursor = request.cursor;
            if (request.limit) timelineParams.limit = request.limit;

            try {
              const response = await authenticatedClient.get(`/feeds/${feedId}/timeline`, {
                params: timelineParams,
                signal: options?.signal,
              });
              // Backend returns posts directly in FeedResponse format
              return response.data;
            } catch (authError: any) {
              // Custom feeds require authentication, so re-throw auth errors
              throw authError;
            }
          }

          // Route all standard feed types through the MTN descriptor-based API
          const descriptor: FeedDescriptor = (request.type || 'for_you') as FeedDescriptor;
          return await this.getMtnFeed(descriptor, {
            cursor: request.cursor,
            limit: request.limit || 20,
            signal: options?.signal,
          });
        } catch (error: any) {
          logger.error('Error fetching feed', {
            message: error?.message,
            status: error?.response?.status,
            statusText: error?.response?.statusText,
            data: error?.response?.data,
            type: request.type,
            stack: error?.stack
          });

          // Re-throw with more context
          const errorMessage = error?.response?.data?.message || error?.response?.data?.error || error?.message || 'Failed to fetch feed';
          const errorToThrow = new Error(errorMessage);
          (errorToThrow as any).status = error?.response?.status;
          (errorToThrow as any).originalError = error;
          throw errorToThrow;
        }
      })();

      if (dedupeKey) {
        inFlightRequests.set(dedupeKey, fetchPromise);
        try {
          return await fetchPromise;
        } finally {
          inFlightRequests.delete(dedupeKey);
        }
      }

      return fetchPromise;
  }

  /**
   * Get user profile feed
   */
  async getUserFeed(userId: string, request: FeedRequest): Promise<FeedServiceResponse> {
    const params: Record<string, unknown> = {};

    if (request.cursor) params.cursor = request.cursor;
    if (request.limit) params.limit = request.limit;
    if (request.type) params.type = request.type;
    if (request.filters) {
      Object.entries(request.filters).forEach(([key, value]) => {
        if (value !== undefined) {
          params[`filters[${key}]`] = value;
        }
      });
    }

    const response = await authenticatedClient.get(`/feed/user/${userId}`, { params });
    return response.data;
  }

  /**
   * Get pinned post for a user profile
   */
  async getPinnedPost(userId: string): Promise<any | null> {
    try {
      const response = await publicClient.get(`/feed/user/${userId}/pinned`);
      return response.data?.item || null;
    } catch {
      return null;
    }
  }

  /**
   * Create a new post
   */
  async createPost(request: CreatePostRequest): Promise<{ success: boolean; post: unknown }> {
    // Map the request to match backend expectations
    const backendRequest = {
      content: {
        ...request.content,
        text: request.content.text || '',
        media: request.content.media || [],
      },
      hashtags: request.hashtags || [],
      mentions: request.mentions || [],
      visibility: request.visibility || 'public',
      parentPostId: request.parentPostId,
      threadId: request.threadId,
      ...(request.status && { status: request.status }),
      ...(request.scheduledFor && { scheduledFor: request.scheduledFor }),
      ...((request as any).metadata && { metadata: (request as any).metadata }),
      ...((request as any).replyPermission && { replyPermission: (request as any).replyPermission }),
      ...((request as any).reviewReplies !== undefined && { reviewReplies: (request as any).reviewReplies }),
      ...((request as any).quotesDisabled !== undefined && { quotesDisabled: (request as any).quotesDisabled }),
    };

    const response = await authenticatedClient.post('/posts', backendRequest);
    const data = response?.data;

    if (data && typeof data === 'object' && data !== null && 'post' in data) {
      return {
        success: typeof (data as Record<string, unknown>).success === 'boolean'
          ? (data as Record<string, boolean>).success
          : true,
        post: (data as Record<string, unknown>).post
      };
    }

    return { success: true, post: data };
  }

  /**
   * Create a thread of posts
   */
  async createThread(request: CreateThreadRequest): Promise<{ success: boolean; posts: unknown[] }> {
    const response = await authenticatedClient.post('/posts/thread', request);
    return { success: true, posts: response.data };
  }

  /**
   * Create a reply
   */
  async createReply(request: CreateReplyRequest): Promise<{ success: boolean; reply: unknown }> {
    const backendRequest = {
      postId: request.postId,
      content: request.content,
      mentions: request.mentions || [],
      hashtags: request.hashtags || []
    };

    const response = await authenticatedClient.post('/feed/reply', backendRequest);
    return { success: true, reply: response.data };
  }

  /**
   * Create a repost
   */
  async createRepost(request: CreateRepostRequest): Promise<{ success: boolean; repost: unknown }> {
    const backendRequest = {
      originalPostId: request.originalPostId,
      content: request.content?.text || '',
      mentions: request.mentions || [],
      hashtags: request.hashtags || []
    };

    const response = await authenticatedClient.post('/feed/repost', backendRequest);
    return { success: true, repost: response.data };
  }

  /**
   * Vote on a post (like = 1, downvote = -1)
   */
  async voteItem(postId: string, value: 1 | -1): Promise<{ success: boolean; data: unknown }> {
    const response = await authenticatedClient.post(`/posts/${postId}/like`, { value });
    return { success: true, data: response.data };
  }

  /**
   * Remove vote from a post
   */
  async removeVote(postId: string): Promise<{ success: boolean; data: unknown }> {
    const response = await authenticatedClient.delete(`/posts/${postId}/like`);
    return { success: true, data: response.data };
  }

  /**
   * Save a post
   */
  async saveItem(request: { postId: string }): Promise<{ success: boolean; data: unknown }> {
    const response = await authenticatedClient.post(`/posts/${request.postId}/save`);
    return { success: true, data: response.data };
  }

  /**
   * Remove save from a post
   */
  async unsaveItem(request: { postId: string }): Promise<{ success: boolean; data: unknown }> {
    const response = await authenticatedClient.delete(`/posts/${request.postId}/save`);
    return { success: true, data: response.data };
  }

  /**
   * Unrepost a post
   */
  async unrepostItem(request: { postId: string }): Promise<{ success: boolean; data: unknown }> {
    const response = await authenticatedClient.delete(`/feed/${request.postId}/repost`);
    return { success: true, data: response.data };
  }


  /**
   * Get saved posts for current user
   */
  async getSavedPosts(request: { page?: number; limit?: number; search?: string } = {}): Promise<{ success: boolean; data: unknown }> {
    const params: Record<string, unknown> = {
      page: request.page || 1,
      limit: request.limit || 20
    };

    if (request.search) {
      params.search = request.search;
    }

    const response = await authenticatedClient.get('/posts/saved', { params });
    return { success: true, data: response.data };
  }

  /**
   * Edit an existing post (within 30-minute edit window)
   */
  async editPost(postId: string, data: { content: { text: string; media?: any[] }; hashtags?: string[]; mentions?: string[] }): Promise<any> {
    const response = await authenticatedClient.put(`/posts/${postId}`, data);
    return response.data;
  }

  /**
   * Get post by ID
   */
  async getPostById(postId: string): Promise<any> {
    try {
      // Prefer transformed feed item for consistent user/enagement shape
      try {
        const transformed = await authenticatedClient.get(`/feed/item/${postId}`);
        return transformed.data;
      } catch (e) {
        // Fallback to posts endpoint for backward compatibility
        const response = await authenticatedClient.get(`/posts/${postId}`);
        return response.data;
      }
    } catch (error: any) {
      // Preserve original error (especially for 404 handling)
      if (error?.response?.status === 404) {
        // Don't log 404s - post may have been deleted
        throw error; // Re-throw original Axios error to preserve status
      }
      // Error will be handled by caller
      throw error; // Re-throw original error instead of creating new one
    }
  }

  /**
   * Update post settings (pin, hide counts, reply permissions, review replies)
   */
  async updatePostSettings(postId: string, settings: {
    isPinned?: boolean;
    hideEngagementCounts?: boolean;
    replyPermission?: ('anyone' | 'followers' | 'following' | 'mentioned' | 'nobody')[];
    reviewReplies?: boolean;
    quotesDisabled?: boolean;
  }): Promise<{ success: boolean; data: unknown }> {
    const response = await authenticatedClient.patch(`/posts/${postId}/settings`, settings);
    return { success: true, data: response.data };
  }

  /**
   * Delete a post
   */
  async deletePost(postId: string): Promise<{ success: boolean }> {
    await authenticatedClient.delete(`/posts/${postId}`);
    return { success: true };
  }

  /**
   * Get posts by hashtag
   */
  async getPostsByHashtag(hashtag: string, request: FeedRequest): Promise<FeedResponse> {
    const params: Record<string, unknown> = {};

    if (request.cursor) params.cursor = request.cursor;
    if (request.limit) params.limit = request.limit;

    const response = await authenticatedClient.get(`/posts/hashtag/${hashtag}`, { params });
    return response.data;
  }

  /**
   * Get posts by extracted topic or entity name
   */
  async getPostsByTopic(topic: string, request: FeedRequest): Promise<FeedResponse> {
    const params: Record<string, unknown> = {};

    if (request.cursor) params.cursor = request.cursor;
    if (request.limit) params.limit = request.limit;

    const response = await authenticatedClient.get(`/posts/topic/${encodeURIComponent(topic)}`, { params });
    return response.data;
  }

  /**
   * Get posts by user mentions
   */
  async getPostsByMentions(userId: string, request: FeedRequest): Promise<FeedResponse> {
    const params: Record<string, unknown> = {};

    if (request.cursor) params.cursor = request.cursor;
    if (request.limit) params.limit = request.limit;

    const response = await authenticatedClient.get(`/posts/mentions/${userId}`, { params });
    return response.data;
  }

  /**
   * Get users who liked a post
   */
  async getPostLikes(postId: string, cursor?: string, limit: number = 50): Promise<{
    users: Array<{
      id: string;
      name: string;
      handle: string;
      avatar: string;
      verified: boolean;
    }>;
    hasMore: boolean;
    nextCursor?: string;
    totalCount: number;
  }> {
    const params: Record<string, unknown> = { limit };
    if (cursor) params.cursor = cursor;

    const response = await authenticatedClient.get(`/posts/${postId}/likes`, { params });
    return response.data;
  }

  /**
   * Get users who reposted a post
   */
  async getPostReposts(postId: string, cursor?: string, limit: number = 50): Promise<{
    users: Array<{
      id: string;
      name: string;
      handle: string;
      avatar: string;
      verified: boolean;
    }>;
    hasMore: boolean;
    nextCursor?: string;
    totalCount: number;
  }> {
    const params: Record<string, unknown> = { limit };
    if (cursor) params.cursor = cursor;

    const response = await authenticatedClient.get(`/posts/${postId}/reposts`, { params });
    return response.data;
  }

  // ────────────────────────────────────────────────────────────
  // MTN Protocol — descriptor-based feed API
  // ────────────────────────────────────────────────────────────

  /**
   * Fetch feed using MTN descriptor-based API.
   * Single endpoint replaces all per-type endpoint routing.
   */
  async getMtnFeed(
    descriptor: FeedDescriptor,
    options?: { cursor?: string; limit?: number; signal?: AbortSignal }
  ): Promise<FeedServiceResponse> {
    const params: Record<string, unknown> = { descriptor };
    if (options?.cursor) params.cursor = options.cursor;
    if (options?.limit) params.limit = options.limit;

    // Cache check
    const cacheKey = `mtn|${descriptor}|${options?.cursor || 'initial'}`;
    const cached = feedCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }

    // Dedup in-flight
    const existing = inFlightRequests.get(cacheKey);
    if (existing) return existing;

    const fetchPromise = (async () => {
      try {
        const response = await authenticatedClient.get('/feed/mtn', {
          params,
          signal: options?.signal,
        });
        const data = response.data?.data || response.data;

        // Cache
        const ttl = options?.cursor ? CACHE_TTL_PAGINATION_MS : CACHE_TTL_MS;
        feedCache.set(cacheKey, { data, timestamp: Date.now(), expiresAt: Date.now() + ttl });

        return data;
      } catch (authError: any) {
        const status = authError?.response?.status;
        if (status === 401 || status === 403) {
          try {
            return await makePublicRequest('/feed/mtn', params);
          } catch {
            throw authError;
          }
        }
        throw authError;
      }
    })();

    inFlightRequests.set(cacheKey, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  }

  /**
   * Peek at the latest item in a feed (for "new posts" indicators).
   */
  async peekMtnFeed(descriptor: FeedDescriptor): Promise<any | null> {
    try {
      const response = await authenticatedClient.get('/feed/mtn/peek', {
        params: { descriptor },
      });
      return response.data?.data || null;
    } catch {
      return null;
    }
  }

  /**
   * Send feed interaction data (impressions, clicks, engagement).
   */
  async sendFeedInteraction(data: {
    feedDescriptor: string;
    postUri: string;
    event: 'impression' | 'click' | 'like' | 'reply' | 'repost' | 'save';
    durationMs?: number;
  }): Promise<void> {
    try {
      await authenticatedClient.post('/feed/mtn/interactions', data);
    } catch {
      // Non-critical — swallow errors
    }
  }

  // ────────────────────────────────────────────────────────────
  // Federation — ActivityPub follow/unfollow
  // ────────────────────────────────────────────────────────────

  /**
   * Send an ActivityPub Follow activity to a remote federated actor.
   */
  async followFederatedActor(actorUri: string): Promise<{ success: boolean; pending: boolean }> {
    const response = await authenticatedClient.post('/federation/follow', { actorUri });
    return response.data;
  }

  /**
   * Send an ActivityPub Undo(Follow) activity to a remote federated actor.
   */
  async unfollowFederatedActor(actorUri: string): Promise<{ success: boolean }> {
    const response = await authenticatedClient.post('/federation/unfollow', { actorUri });
    return response.data;
  }
}

export const feedService = new FeedService(); 
