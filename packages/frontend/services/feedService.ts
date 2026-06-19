import {
  FeedRequest,
  FeedResponse,
  SlicedFeedResponse,
  CreateReplyRequest,
  CreateBoostRequest,
  CreatePostRequest,
  CreateThreadRequest,
  LikeRequest,
  UnlikeRequest,
  FeedType,
  FeedDescriptor,
  isValidFeedDescriptor,
  HydratedPost,
  UpdatePostRequest,
} from '@mention/shared-types';

// Feed responses may include slices for thread grouping
type FeedServiceResponse = FeedResponse & Partial<Pick<SlicedFeedResponse, 'slices'>>;
import { FeedFilters } from '../utils/feedUtils';
import { authenticatedClient, publicClient } from '../utils/api';
import { oxyServices } from '@/lib/oxyServices';
import { logger } from '@/lib/logger';
import { normalizeApiError } from '@/utils/apiError';

/**
 * In-flight dedup discriminator for the viewer's auth state.
 *
 * Returns `'auth'` when an access token is present, `'anon'` otherwise. This is
 * folded into the in-flight request key so an authenticated fetch can never
 * piggyback on an in-flight anonymous fetch's promise (or vice versa) for the
 * same descriptor — the two return different content and must resolve
 * independently. Critically, this prevents an anon load issued during the
 * cold-boot auth-not-ready window from masking the later authenticated fetch.
 */
function authDedupeMarker(): 'auth' | 'anon' {
  try {
    return oxyServices.getClient().getAccessToken() ? 'auth' : 'anon';
  } catch {
    return 'anon';
  }
}

// Extended FeedRequest with frontend-specific filter properties
interface ExtendedFeedRequest extends Omit<FeedRequest, 'filters'> {
  filters?: FeedFilters;
  sort?: string;
}

interface PublicReadRequestConfig {
  params?: Record<string, unknown>;
  signal?: AbortSignal;
}

interface FeedDataEnvelope {
  data: FeedServiceResponse;
}

interface PostEngagementUsersResponse {
  users: Array<{ id: string; displayName: string; handle: string; avatar?: string; verified: boolean }>;
  hasMore: boolean;
  nextCursor?: string;
  totalCount: number;
}

type FeedDataResponse = FeedServiceResponse | FeedDataEnvelope;

interface PinnedPostResponse {
  item?: HydratedPost | null;
}

interface MtnPeekResponse {
  data?: HydratedPost | null;
}

function hasFeedDataEnvelope(response: FeedDataResponse): response is FeedDataEnvelope {
  return typeof response === 'object' && response !== null && 'data' in response;
}

const makePublicRequest = async <T = unknown>(
  endpoint: string,
  config?: PublicReadRequestConfig
): Promise<T> => {
  try {
    const response = await publicClient.get<T>(endpoint, config);
    return response.data;
  } catch (error) {
    const { message } = normalizeApiError(error);
    // Preserve the original error (HTTP status, server payload) via `cause`.
    throw new Error(message, { cause: error });
  }
};

const makeViewerAwarePublicRead = async <T = unknown>(
  endpoint: string,
  config?: PublicReadRequestConfig
): Promise<T> => {
  if (authDedupeMarker() === 'anon') {
    return await makePublicRequest<T>(endpoint, config);
  }

  try {
    const response = await authenticatedClient.get<T>(endpoint, config);
    return response.data;
  } catch (authError) {
    const { status } = normalizeApiError(authError);
    if (status === 401) {
      try {
        return await makePublicRequest<T>(endpoint, config);
      } catch (publicError) {
        logger.warn('Public feed fallback failed', {
          endpoint,
          ...normalizeApiError(publicError),
        });
        throw authError;
      }
    }

    throw authError;
  }
};

interface FeedServiceOptions {
  signal?: AbortSignal;
}

// In-flight request deduplication (transient — stays in memory, not SQLite)
const inFlightRequests = new Map<string, Promise<FeedServiceResponse>>();

// Generate stable dedup key from request
function getDedupeKey(request: ExtendedFeedRequest): string {
  const filters = request.filters;
  const filterKey = filters
    ? Object.keys(filters)
        .sort()
        .map((k) => `${k}=${(filters as Record<string, unknown>)[k] ?? ''}`)
        .join('&')
    : '';
  return `${authDedupeMarker()}|${request.type || 'mixed'}|${request.cursor || 'initial'}|${request.userId || ''}|${request.sort || ''}|${filterKey}`;
}

class FeedService {
  /**
   * Get feed data from backend.
   * Caching is now handled by SQLite via postsStore — this is a pure network layer.
   */
  async getFeed(request: ExtendedFeedRequest, options?: FeedServiceOptions): Promise<FeedServiceResponse> {
      // Deduplicate in-flight requests — but ONLY for signal-less callers. A
      // request carrying an AbortSignal is owned by a single caller whose
      // lifecycle controls the abort; it must neither be served from the shared
      // cache (it would inherit a foreign abort and reject as "canceled") nor
      // stored into it (its abort would poison every other deduped caller). See
      // the matching guard in getMtnFeed for the full rationale (this was the
      // root cause of the empty-feed-on-remount bug).
      const dedupeKey = getDedupeKey(request);
      const canShare = !options?.signal;
      if (canShare) {
        const inFlight = inFlightRequests.get(dedupeKey);
        if (inFlight) return inFlight;
      }

      const fetchPromise = (async () => {
        try {
          // Handle hashtag feed
          if (request.type === 'hashtag' && request.filters?.hashtag) {
            const tag = encodeURIComponent(request.filters.hashtag);
            const tagParams: Record<string, string | number> = {};
            if (request.cursor) tagParams.cursor = request.cursor;
            if (request.limit) tagParams.limit = request.limit;

            return await makeViewerAwarePublicRead<FeedServiceResponse>(`/posts/hashtag/${tag}`, {
              params: tagParams,
              signal: options?.signal,
            });
          }

          // Handle topic feed
          if (request.type === 'topic' && request.filters?.topic) {
            const topic = encodeURIComponent(request.filters.topic);
            const topicParams: Record<string, string | number> = {};
            if (request.cursor) topicParams.cursor = request.cursor;
            if (request.limit) topicParams.limit = request.limit;

            return await makeViewerAwarePublicRead<FeedServiceResponse>(`/posts/topic/${topic}`, {
              params: topicParams,
              signal: options?.signal,
            });
          }

          // Handle custom feed
          if (request.type === 'custom' && request.filters?.customFeedId) {
            const feedId = request.filters.customFeedId;
            const timelineParams: Record<string, string | number> = {};
            if (request.cursor) timelineParams.cursor = request.cursor;
            if (request.limit) timelineParams.limit = request.limit;

            const response = await authenticatedClient.get<FeedServiceResponse>(`/feeds/${feedId}/timeline`, {
              params: timelineParams,
              signal: options?.signal,
            });
            return response.data;
          }

          // Handle replies feed
          if (request.type === 'replies') {
            const parentId = request.filters?.parentPostId || request.filters?.postId;
            if (!parentId) {
              return { items: [], hasMore: false, nextCursor: undefined, totalCount: 0 };
            }
            const repliesParams: Record<string, string | number> = {};
            if (request.cursor) repliesParams.cursor = request.cursor;
            if (request.limit) repliesParams.limit = request.limit;
            if (request.filters?.sort) repliesParams.sort = request.filters.sort;

            const response = await authenticatedClient.get<FeedServiceResponse>(`/feed/replies/${parentId}`, {
              params: repliesParams,
              signal: options?.signal,
            });
            return response.data;
          }

          // Route standard feeds through MTN descriptor-based API
          const descriptor: FeedDescriptor = (request.type || 'for_you') as FeedDescriptor;
          return await this.getMtnFeed(descriptor, {
            cursor: request.cursor,
            limit: request.limit || 20,
            signal: options?.signal,
          });
        } catch (error) {
          const normalized = normalizeApiError(error);
          logger.error('Error fetching feed', {
            message: normalized.message,
            status: normalized.status,
            code: normalized.code,
            feedType: request.type,
          });

          // Preserve the original error (status, server payload, stack) via
          // `cause` so callers can recover context with `normalizeApiError`.
          throw new Error(normalized.message || 'Failed to fetch feed', { cause: error });
        }
      })();

      if (!canShare) {
        return await fetchPromise;
      }

      inFlightRequests.set(dedupeKey, fetchPromise);
      try {
        return await fetchPromise;
      } finally {
        inFlightRequests.delete(dedupeKey);
      }
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

    return await makeViewerAwarePublicRead<FeedServiceResponse>(`/feed/user/${userId}`, { params });
  }

  /**
   * Get pinned post for a user profile
   */
  async getPinnedPost(userId: string): Promise<HydratedPost | null> {
    try {
      const response = await publicClient.get<PinnedPostResponse>(`/feed/user/${userId}/pinned`);
      return response.data.item ?? null;
    } catch (error) {
      // Absence of a pinned post is expected (404); log at debug so a real
      // server/network failure is still observable without being noisy.
      logger.debug('No pinned post resolved', { userId, ...normalizeApiError(error) });
      return null;
    }
  }

  /**
   * Create a new post.
   *
   * Maps the camelCase {@link CreatePostRequest} into the backend's
   * snake_case wire format (e.g. `quotedPostId` → `quoted_post_id`).
   */
  async createPost(request: CreatePostRequest): Promise<{ success: boolean; post: unknown }> {
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
      ...(request.metadata && { metadata: request.metadata }),
      ...(request.replyPermission && { replyPermission: request.replyPermission }),
      ...(request.reviewReplies !== undefined && { reviewReplies: request.reviewReplies }),
      ...(request.quotesDisabled !== undefined && { quotesDisabled: request.quotesDisabled }),
      // Backend expects `quoted_post_id` (snake_case) as a TOP-LEVEL field;
      // the controller reads it from `req.body.quoted_post_id`, not from
      // `content` or `metadata`. Keep it out of the payload when empty so
      // we don't accidentally turn a regular post into an empty-quote.
      ...(request.quotedPostId && { quoted_post_id: request.quotedPostId }),
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
    const data = response?.data;

    if (data && typeof data === 'object' && data !== null && 'posts' in data) {
      return {
        success: typeof (data as Record<string, unknown>).success === 'boolean'
          ? (data as Record<string, boolean>).success
          : true,
        posts: Array.isArray((data as Record<string, unknown>).posts)
          ? (data as Record<string, unknown[]>).posts
          : []
      };
    }

    return { success: true, posts: Array.isArray(data) ? data : [] };
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
   * Create a boost
   */
  async createBoost(request: CreateBoostRequest): Promise<{ success: boolean; boost: unknown }> {
    const backendRequest = {
      originalPostId: request.originalPostId,
      content: request.content?.text || '',
      mentions: request.mentions || [],
      hashtags: request.hashtags || []
    };

    const response = await authenticatedClient.post('/feed/boost', backendRequest);
    return { success: true, boost: response.data };
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
   * Unboost a post
   */
  async unboostItem(request: { postId: string }): Promise<{ success: boolean; data: unknown }> {
    const response = await authenticatedClient.delete(`/feed/${request.postId}/boost`);
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
   * Edit an existing post
   */
  async editPost(postId: string, data: UpdatePostRequest): Promise<HydratedPost> {
    const response = await authenticatedClient.put<HydratedPost>(`/posts/${postId}`, data);
    return response.data;
  }

  /**
   * Get post by ID
   */
  async getPostById(postId: string): Promise<HydratedPost> {
    try {
      return await makeViewerAwarePublicRead<HydratedPost>(`/feed/item/${postId}`);
    } catch (error) {
      // The feed-item endpoint may legitimately 404 for non-feed posts; fall
      // back to the posts endpoint. Log so a non-404 failure is observable.
      logger.debug('Feed-item lookup failed, falling back to /posts', {
        postId,
        ...normalizeApiError(error),
      });
    }
    return await makeViewerAwarePublicRead<HydratedPost>(`/posts/${postId}`);
  }

  /**
   * Update post settings
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

    return await makeViewerAwarePublicRead<FeedResponse>(`/posts/hashtag/${hashtag}`, { params });
  }

  /**
   * Get posts by topic
   */
  async getPostsByTopic(topic: string, request: FeedRequest): Promise<FeedResponse> {
    const params: Record<string, unknown> = {};
    if (request.cursor) params.cursor = request.cursor;
    if (request.limit) params.limit = request.limit;

    return await makeViewerAwarePublicRead<FeedResponse>(`/posts/topic/${encodeURIComponent(topic)}`, { params });
  }

  /**
   * Get users who liked a post
   */
  async getPostLikes(postId: string, cursor?: string, limit: number = 50): Promise<PostEngagementUsersResponse> {
    const params: Record<string, unknown> = { limit };
    if (cursor) params.cursor = cursor;

    const response = await authenticatedClient.get<PostEngagementUsersResponse>(`/posts/${postId}/likes`, { params });
    return response.data;
  }

  /**
   * Get users who boosted a post
   */
  async getPostBoosts(postId: string, cursor?: string, limit: number = 50): Promise<PostEngagementUsersResponse> {
    const params: Record<string, unknown> = { limit };
    if (cursor) params.cursor = cursor;

    const response = await authenticatedClient.get<PostEngagementUsersResponse>(`/posts/${postId}/boosts`, { params });
    return response.data;
  }

  // ────────────────────────────────────────────────────────────
  // MTN Protocol — descriptor-based feed API
  // ────────────────────────────────────────────────────────────

  /**
   * Fetch feed using MTN descriptor-based API.
   */
  async getMtnFeed(
    descriptor: FeedDescriptor,
    options?: { cursor?: string; limit?: number; signal?: AbortSignal }
  ): Promise<FeedServiceResponse> {
    const params: Record<string, unknown> = { descriptor };
    if (options?.cursor) params.cursor = options.cursor;
    if (options?.limit) params.limit = options.limit;

    // Dedup in-flight. Keyed on the viewer's auth state so an authenticated fetch
    // never shares an in-flight promise with an anonymous one for the same
    // descriptor — the two return different content and must resolve independently.
    const cacheKey = `mtn|${authDedupeMarker()}|${descriptor}|${options?.cursor || 'initial'}`;

    // In-flight sharing is ONLY safe for signal-less requests. A request that
    // carries an AbortSignal is owned by a single caller whose lifecycle controls
    // the abort: it must neither be served from the shared cache (it would inherit
    // a foreign abort and reject as "canceled") nor stored into it (its abort
    // would poison every other caller awaiting the shared promise). This was the
    // root cause of the empty feed: the feed hook remounting mid-load aborted the
    // first request, and the second request — which shared the first's in-flight
    // promise — inherited that cancellation instead of making its own fetch.
    const canShare = !options?.signal;
    if (canShare) {
      const existing = inFlightRequests.get(cacheKey);
      if (existing) return existing;
    }

    const fetchPromise = (async () => {
      const response = await makeViewerAwarePublicRead<FeedDataResponse>('/feed/mtn', {
        params,
        signal: options?.signal,
      });
      return hasFeedDataEnvelope(response) ? response.data : response;
    })();

    if (!canShare) {
      return await fetchPromise;
    }

    inFlightRequests.set(cacheKey, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  }

  /**
   * Peek at the latest item in a feed
   */
  async peekMtnFeed(descriptor: FeedDescriptor): Promise<HydratedPost | null> {
    try {
      const response = await makeViewerAwarePublicRead<MtnPeekResponse>('/feed/mtn/peek', {
        params: { descriptor },
      });
      return response.data ?? null;
    } catch (error) {
      // Peek is a best-effort "new posts available" probe; a failure must not
      // surface to the user, but log it so it's not invisible.
      logger.debug('Feed peek failed', { descriptor, ...normalizeApiError(error) });
      return null;
    }
  }

  /**
   * Send feed interaction data
   */
  async sendFeedInteraction(data: {
    feedDescriptor: string;
    postUri: string;
    event: 'impression' | 'click' | 'like' | 'reply' | 'boost' | 'save';
    durationMs?: number;
  }): Promise<void> {
    try {
      await authenticatedClient.post('/feed/mtn/interactions', data);
    } catch (error) {
      // Telemetry write — non-critical to the user, but log so silent loss of
      // feed-ranking signal is observable in diagnostics.
      logger.debug('Failed to send feed interaction', {
        event: data.event,
        ...normalizeApiError(error),
      });
    }
  }

  // ────────────────────────────────────────────────────────────
  // Federation — ActivityPub follow/unfollow
  // ────────────────────────────────────────────────────────────

  async followFederatedActor(actorUri: string): Promise<{ success: boolean; pending: boolean }> {
    const response = await authenticatedClient.post<{ success: boolean; pending: boolean }>('/federation/follow', { actorUri });
    return response.data;
  }

  async unfollowFederatedActor(actorUri: string): Promise<{ success: boolean }> {
    const response = await authenticatedClient.post<{ success: boolean }>('/federation/unfollow', { actorUri });
    return response.data;
  }
}

export const feedService = new FeedService();
