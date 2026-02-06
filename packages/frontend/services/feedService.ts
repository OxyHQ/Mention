import {
  FeedRequest, 
  FeedResponse, 
  CreateReplyRequest, 
  CreateRepostRequest,
  CreatePostRequest,
  CreateThreadRequest,
  LikeRequest,
  UnlikeRequest,
  FeedType
} from '@mention/shared-types';
import { FeedFilters } from '../utils/feedUtils';
import { authenticatedClient, API_CONFIG } from '../utils/api';
import { logger } from '../utils/logger';

// Extended FeedRequest with frontend-specific filter properties
interface ExtendedFeedRequest extends Omit<FeedRequest, 'filters'> {
  filters?: FeedFilters;
}

// Helper function to make unauthenticated requests using fetch
const makePublicRequest = async (endpoint: string, params?: Record<string, any>): Promise<any> => {
  // Ensure endpoint starts with /api
  const apiEndpoint = endpoint.startsWith('/api') ? endpoint : `/api${endpoint}`;
  
  // Handle baseURL - API_URL might already include /api/ in production
  let baseURL = API_CONFIG.baseURL;
  if (baseURL.endsWith('/api/')) {
    baseURL = baseURL.slice(0, -5); // Remove trailing /api/
  } else if (baseURL.endsWith('/api')) {
    baseURL = baseURL.slice(0, -4); // Remove trailing /api
  }
  
  const url = new URL(apiEndpoint, baseURL.endsWith('/') ? baseURL : `${baseURL}/`);
  
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value));
      }
    });
  }
  
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    let errorData;
    try {
      errorData = JSON.parse(errorText);
    } catch {
      errorData = { message: errorText };
    }
    throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
  }
  
  return response.json();
};

interface FeedServiceOptions {
  signal?: AbortSignal;
}

interface CachedFeedResponse {
  data: FeedResponse;
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
  return `${request.type || 'mixed'}|${request.cursor || 'initial'}|${request.userId || ''}|${filterKey}`;
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

class FeedService {
  /**
   * Get feed data from backend using Oxy authenticated client
   * Includes client-side caching for 30 seconds to reduce redundant requests
   */
  async getFeed(request: ExtendedFeedRequest, options?: FeedServiceOptions): Promise<FeedResponse> {
      // Check cache first (only for non-cursor requests to avoid stale pagination)
      if (!request.cursor) {
        const cacheKey = getCacheKey(request);
        const cached = feedCache.get(cacheKey);
        if (cached && Date.now() < cached.expiresAt) {
          logger.debug('[FeedService] Cache hit', { type: request.type });
          return cached.data;
        }
      }
      
      const params: any = {
        type: request.type // Always include type in params
      };
      
      if (request.cursor) params.cursor = request.cursor;
      if (request.limit) params.limit = request.limit;
      if (request.userId) params.userId = request.userId;
      if (request.filters) {
        Object.entries(request.filters).forEach(([key, value]) => {
          if (value !== undefined) {
            // Special handling for array-based filters
            if (key === 'authors' && Array.isArray(value)) {
              params[`filters[${key}]`] = (value as any[]).join(',');
            } else {
              params[`filters[${key}]`] = value as any;
            }
          }
        });
      }

      // Map feed types to backend endpoints
      let endpoint = '/feed/feed'; // default endpoint
    
    try {
      
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
      
      switch (request.type) {
        case 'for_you':
          endpoint = '/feed/for-you';
          break;
        case 'following':
          endpoint = '/feed/following';
          break;
        case 'media':
          endpoint = '/feed/media';
          break;
        case 'replies':
          endpoint = '/feed/replies';
          break;
        case 'reposts':
          endpoint = '/feed/reposts';
          break;
        case 'posts':
          endpoint = '/feed/posts';
          break;
        case 'saved':
          endpoint = '/feed/feed'; // Use main feed endpoint with type='saved'
          // type is already set in params above
          break;
        case 'explore':
          endpoint = '/feed/explore';
          break;
        case 'mixed':
        default:
          endpoint = '/feed/feed';
          break;
      }

      try {
        const response = await authenticatedClient.get(endpoint, { 
          params,
          signal: options?.signal,
        });
        
        const feedResponse = response.data;
        
        // Cache response with appropriate TTL based on request type
        if (feedResponse) {
          const cacheKey = getCacheKey(request);
          const ttl = request.cursor ? CACHE_TTL_PAGINATION_MS : CACHE_TTL_MS;
          feedCache.set(cacheKey, {
            data: feedResponse,
            timestamp: Date.now(),
            expiresAt: Date.now() + ttl
          });
        }
        
        return feedResponse;
      } catch (authError: any) {
        const status = authError?.response?.status;
        const isAuthError = status === 401 || status === 403;
        const isNetworkError = !authError?.response && authError?.message?.includes('Network');
        
        if (isAuthError || isNetworkError) {
          try {
            return await makePublicRequest(endpoint, params);
          } catch (publicError: any) {
            throw isAuthError ? authError : publicError;
          }
        }
        throw authError;
      }
    } catch (error: any) {
      logger.error('Error fetching feed', {
        message: error?.message,
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        data: error?.response?.data,
        endpoint,
        params,
        stack: error?.stack
      });
      
      // Re-throw with more context
      const errorMessage = error?.response?.data?.message || error?.response?.data?.error || error?.message || 'Failed to fetch feed';
      const errorToThrow = new Error(errorMessage);
      (errorToThrow as any).status = error?.response?.status;
      (errorToThrow as any).originalError = error;
      throw errorToThrow;
    }
  }

  /**
   * Get user profile feed
   */
  async getUserFeed(userId: string, request: FeedRequest): Promise<FeedResponse> {
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
   * Create a new post
   */
  async createPost(request: CreatePostRequest): Promise<{ success: boolean; post: unknown }> {
    // Map the request to match backend expectations
    const backendRequest = {
      content: {
        text: request.content.text || '',
        media: request.content.media || [],
        ...(request.content.poll && { poll: request.content.poll }),
        ...(request.content.location && { location: request.content.location }),
        ...(request.content.sources && request.content.sources.length > 0 && { sources: request.content.sources }),
        ...(request.content.article && Object.keys(request.content.article).length > 0 && { article: request.content.article }),
        ...(request.content.attachments && request.content.attachments.length > 0 && { attachments: request.content.attachments })
      },
      hashtags: request.hashtags || [],
      mentions: request.mentions || [],
      visibility: request.visibility || 'public',
      parentPostId: request.parentPostId,
      threadId: request.threadId,
      ...(request.status && { status: request.status }),
      ...(request.scheduledFor && { scheduledFor: request.scheduledFor })
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
   * Like a post
   */
  async likeItem(request: LikeRequest): Promise<{ success: boolean; data: unknown }> {
    const response = await authenticatedClient.post(`/posts/${request.postId}/like`);
    return { success: true, data: response.data };
  }

  /**
   * Unlike a post
   */
  async unlikeItem(request: UnlikeRequest): Promise<{ success: boolean; data: unknown }> {
    const response = await authenticatedClient.delete(`/posts/${request.postId}/like`);
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
    replyPermission?: 'anyone' | 'followers' | 'following' | 'mentioned';
    reviewReplies?: boolean;
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
}

export const feedService = new FeedService(); 
