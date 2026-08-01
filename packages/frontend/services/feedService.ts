import {
  buildFeedDescriptor,
  isAuthorFeedFilter,
} from '@mention/shared-types/mtn/feedDescriptor';
import type {
  AuthorFeedFilter,
} from '@mention/shared-types/mtn/feedDescriptor';
import type {
  FeedRequest,
  FeedResponse,
  SlicedFeedResponse,
  CreateReplyRequest,
  CreateBoostRequest,
  CreatePostRequest,
  CreateThreadRequest,
  FeedDescriptor,
  HydratedPost,
  UpdatePostRequest,
  FeedInteractionInput,
  FeedInterstitialEventInput,
  PostEditSource,
  PostUser,
} from '@mention/shared-types';

import {
  MAX_WIDGET_HANDOFF_POSTS,
  prefetchFollowingWidgetFeed,
  syncFeedWidget,
} from '../modules/mention-widgets/feedWidgetSync';
import { FeedFilters } from '../utils/feedUtils';
import { authenticatedClient, publicClient, isNotFoundError } from '../utils/api';
import { oxyServices } from '@/lib/oxyServices';
import { logger } from '@oxyhq/core/logger';
import { normalizeApiError } from '@/utils/apiError';
import {
  buildBookmarkFolderMoveRequest,
  buildSavedPostsRequestConfig,
  type SavedPostsRequest,
} from './savedPostsRequest';

// Feed responses may include slices for thread grouping, and recommendation-card
// placements (`interstitials`) for authenticated viewers on the descriptors the
// backend allows. Both are top-level, optional fields the response carries through
// unchanged — the card CONTENT is fetched lazily by each card component, so a feed
// response never blocks on recommendations.
type FeedServiceResponse = FeedResponse & Partial<Pick<SlicedFeedResponse, 'slices' | 'interstitials'>>;

/** The network a resolved external actor belongs to (matches the backend `NetworkId`). */
export type ExternalNetwork = 'activitypub' | 'atproto';

/**
 * A normalized cross-network actor returned by `GET /federation/resolve`.
 * Mirrors the backend connectors route response shape exactly.
 */
export interface ExternalActorResolution {
  /** The network that owns the actor. */
  network: ExternalNetwork;
  /** Canonical protocol id: an ActivityPub actor URI, or an atproto DID. Used as the follow target. */
  externalId: string;
  /** Fediverse-style handle (`user@domain` for ActivityPub; the atproto handle/DID otherwise). */
  handle: string;
  /** Canonical Oxy display name, when resolved. */
  displayName?: string;
  /** Actor avatar URL (a remote URL, proxied at render time). */
  avatarUrl?: string;
  /** The Oxy user this actor maps to, once minted — drives profile navigation. */
  oxyUserId?: string;
  /** Whether the current viewer already follows this actor. */
  followed: boolean;
}

/** A page of the viewer's saved posts, as returned by `GET /posts/saved`. */
export interface SavedPostsPage {
  posts: HydratedPost[];
  hasMore: boolean;
  page: number;
  limit: number;
}

export type { SavedPostsRequest } from './savedPostsRequest';

export interface BookmarkFoldersResponse {
  folders: string[];
}

let viewerRequestGeneration = 0;
let activeViewerRequestScope: string | null | undefined;
let credentialGeneration = 0;
let activeAccessToken: string | undefined;

function readAccessToken(): string | undefined {
  try {
    return oxyServices.getClient().getAccessToken() || undefined;
  } catch {
    return undefined;
  }
}

function authDedupeMarker(): 'auth' | 'anon' {
  return readAccessToken() ? 'auth' : 'anon';
}

/**
 * The account this client is currently authorized as, decoded from the bearer —
 * the server's own answer rather than app state.
 *
 * Guarded like {@link readAccessToken} beside it, and for the same reason: the
 * only caller is the home-screen widget handoff, which is an ENHANCEMENT riding
 * on a feed request. A missing method on an older SDK, or a test double that
 * stubs only part of the client, must degrade to "no viewer identity" — never
 * reject the feed the reader is waiting for.
 *
 * `null` is a first-class answer downstream: it is what an anonymous read looks
 * like, and the handoff policy already refuses to attribute a personal timeline
 * without one.
 */
function readViewerId(): string | null {
  try {
    return oxyServices.getCurrentUserId();
  } catch {
    return null;
  }
}

/**
 * In-flight dedup discriminator for the exact authenticated identity generation.
 *
 * `auth|anon` alone is insufficient: two authenticated accounts can request the
 * same descriptor while A's request is still pending, and B must never inherit
 * A's personalized hydration. The identity boundary advances
 * `viewerRequestGeneration`; the credential generation is a fail-safe for token
 * changes that occur before that boundary renders.
 */
function requestIdentityDedupeMarker(): string {
  const accessToken = readAccessToken();
  if (!accessToken) {
    if (activeAccessToken !== undefined) {
      activeAccessToken = undefined;
      credentialGeneration += 1;
    }
    return 'anon';
  }

  if (accessToken !== activeAccessToken) {
    activeAccessToken = accessToken;
    credentialGeneration += 1;
  }

  return `auth:v${viewerRequestGeneration}:c${credentialGeneration}`;
}

// Extended FeedRequest with frontend-specific filter properties
export interface ExtendedFeedRequest extends Omit<FeedRequest, 'filters'> {
  filters?: FeedFilters;
}

interface PublicReadRequestConfig {
  params?: Record<string, unknown>;
  signal?: AbortSignal;
}

interface FeedDataEnvelope {
  data: FeedServiceResponse;
}

interface PostEngagementUsersResponse {
  // The engagement endpoints (`GET /posts/:id/likes` and `.../boosts`) return the
  // canonical Oxy `PostUser` per liker/booster (same shape as `post.user`) —
  // `username` + structured `name.displayName`, NOT a flat `{ displayName, handle }`.
  // The renderer derives the `@handle` via `getNormalizedUserHandle`.
  users: PostUser[];
  hasMore: boolean;
  nextCursor?: string;
  totalCount: number;
}

/**
 * Social proof for a focused post (`GET /posts/:id/likes/known`): the likers the
 * VIEWER follows, as a fixed-size avatar sample plus the exact total. Distinct
 * from {@link PostEngagementUsersResponse}, which is the cursor-paginated list
 * of everybody who liked the post.
 */
export interface PostKnownLikersResponse {
  /** Canonical Oxy `PostUser` per liker, same shape as `post.user`. */
  likers: PostUser[];
  /** Every liker the viewer follows, not just the sampled ones. */
  total: number;
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

/**
 * Starts a new viewer-owned request generation.
 *
 * Called before the identity boundary renders a new viewer. Clearing the map
 * drops references to old shared promises; generation-scoped keys also ensure a
 * late `finally` from A cannot affect B's in-flight entry.
 */
export function setFeedViewerRequestScope(viewerId: string | null): void {
  const normalizedViewerId = viewerId?.trim() || null;
  if (activeViewerRequestScope === normalizedViewerId) return;

  activeViewerRequestScope = normalizedViewerId;
  viewerRequestGeneration += 1;
  inFlightRequests.clear();
}

// Generate stable dedup key from request
function getDedupeKey(request: ExtendedFeedRequest): string {
  const filters = request.filters;
  const filterKey = filters
    ? Object.keys(filters)
        .sort()
        .map((k) => `${k}=${filters[k] ?? ''}`)
        .join('&')
    : '';
  return `${requestIdentityDedupeMarker()}|${request.type || 'mixed'}|${request.cursor || 'initial'}|${request.userId || ''}|${filterKey}`;
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

          // Handle the per-trend feed — the posts behind one trending term.
          //
          // Routed through the MTN descriptor API rather than a legacy REST path
          // (as hashtag/topic above still are) because the term space it matches
          // exists only on that engine: `trend|<term>` unions the extracted
          // terms, hashtags and topic slugs exactly as detection counted them,
          // which is what stops a trend from opening an empty screen.
          if (request.type === 'trend' && request.filters?.trend) {
            return await this.getMtnFeed(`trend|${request.filters.trend}`, {
              cursor: request.cursor,
              limit: request.limit || 20,
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

          // Handle quotes feed — the posts quoting a given post, behind the
          // post-detail screen's "N quotes" count.
          if (request.type === 'quotes') {
            const quotedId = request.filters?.postId;
            if (!quotedId) {
              return { items: [], hasMore: false, nextCursor: undefined, totalCount: 0 };
            }
            const quotesParams: Record<string, string | number> = {};
            if (request.cursor) quotesParams.cursor = request.cursor;
            if (request.limit) quotesParams.limit = request.limit;

            return await makeViewerAwarePublicRead<FeedServiceResponse>(`/feed/quotes/${quotedId}`, {
              params: quotesParams,
              signal: options?.signal,
            });
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
          logger.error('Error fetching feed', undefined, {
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
   * Get a user's profile feed — one tab of it.
   *
   * Served by the MTN engine like every other feed: the profile tab is just the
   * author descriptor `author|<oxyUserId>|<tab>`. An unrecognized tab degrades
   * to the default `posts` filter, matching the backend's own descriptor
   * resolution.
   */
  async getUserFeed(
    userId: string,
    request: FeedRequest,
    options?: FeedServiceOptions,
  ): Promise<FeedServiceResponse> {
    const filter: AuthorFeedFilter = isAuthorFeedFilter(request.type) ? request.type : 'posts';
    return await this.getMtnFeed(buildFeedDescriptor('author', userId, filter), {
      cursor: request.cursor,
      limit: request.limit,
      signal: options?.signal,
    });
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
  async createPost(request: CreatePostRequest): Promise<{ success: boolean; post: HydratedPost | null }> {
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
      ...(request.collaboratorIds && request.collaboratorIds.length > 0 && { collaboratorIds: request.collaboratorIds }),
    };

    const response = await authenticatedClient.post<{ success?: boolean; post?: HydratedPost }>('/posts', backendRequest);
    const data = response?.data;

    if (data && typeof data === 'object' && data.post) {
      return {
        success: typeof data.success === 'boolean' ? data.success : true,
        post: data.post,
      };
    }

    return { success: true, post: null };
  }

  /**
   * Create a thread of posts
   */
  async createThread(request: CreateThreadRequest): Promise<{ success: boolean; posts: HydratedPost[] }> {
    const response = await authenticatedClient.post<{
      success?: boolean;
      posts?: HydratedPost[];
    }>('/posts/thread', request);
    const data = response?.data;

    if (data && typeof data === 'object' && Array.isArray(data.posts)) {
      return {
        success: typeof data.success === 'boolean' ? data.success : true,
        posts: data.posts,
      };
    }

    return { success: true, posts: [] };
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
   * Create a boost.
   *
   * `source` (optional) is the originating feed descriptor (e.g. 'videos',
   * 'for_you', 'author|<id>'). The backend uses it for surface-aware engagement
   * attribution — a boost from the Videos feed signals interest in the video
   * content, not the author. Omitted from the payload when absent so the request
   * stays byte-identical for non-feed callers.
   */
  async createBoost(request: CreateBoostRequest, source?: string): Promise<{ success: boolean; boost: unknown }> {
    const backendRequest = {
      originalPostId: request.originalPostId,
      content: request.content?.text || '',
      mentions: request.mentions || [],
      hashtags: request.hashtags || [],
      ...(source ? { source } : {}),
    };

    const response = await authenticatedClient.post('/feed/boost', backendRequest);
    return { success: true, boost: response.data };
  }

  /**
   * Vote on a post (like = 1, downvote = -1).
   *
   * `source` (optional) is the originating feed descriptor for surface-aware
   * engagement attribution; omitted from the payload when absent.
   */
  async voteItem(postId: string, value: 1 | -1, source?: string): Promise<{ success: boolean; data: unknown }> {
    const response = await authenticatedClient.post(`/posts/${postId}/like`, {
      value,
      ...(source ? { source } : {}),
    });
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
   * Save a post.
   *
   * `source` (optional) is the originating feed descriptor for surface-aware
   * engagement attribution; omitted from the body when absent.
   */
  async saveItem(request: { postId: string }, source?: string): Promise<{ success: boolean; data: unknown }> {
    const response = await authenticatedClient.post(
      `/posts/${request.postId}/save`,
      source ? { source } : undefined,
    );
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
  async getSavedPosts(request: SavedPostsRequest = {}): Promise<{ success: boolean; data: SavedPostsPage }> {
    const response = await authenticatedClient.get<SavedPostsPage>(
      '/posts/saved',
      buildSavedPostsRequestConfig(request),
    );
    return { success: true, data: response.data };
  }

  async getBookmarkFolders(signal?: AbortSignal): Promise<string[]> {
    const response = await authenticatedClient.get<BookmarkFoldersResponse>(
      '/posts/bookmarks/folders',
      { signal },
    );
    return response.data.folders ?? [];
  }

  async moveBookmarkToFolder(
    postId: string,
    folder: string | null,
  ): Promise<void> {
    const request = buildBookmarkFolderMoveRequest(postId, folder);
    await authenticatedClient.patch(request.url, request.data);
  }

  /**
   * Edit an existing post
   */
  async editPost(postId: string, data: UpdatePostRequest): Promise<HydratedPost> {
    const response = await authenticatedClient.put<HydratedPost>(`/posts/${postId}`, data);
    return response.data;
  }

  /**
   * Fetch the owner's persisted author source for editing. A hydrated post is
   * unsuitable here because its mention ids have already become display links
   * and its body may be selected for the viewer's language.
   */
  async getPostEditSource(postId: string, signal?: AbortSignal): Promise<PostEditSource> {
    const response = await authenticatedClient.get<PostEditSource>(
      `/posts/${postId}/edit-source`,
      { signal },
    );
    return response.data;
  }

  /**
   * Translate a body the author is still writing, for a language tab in the
   * composer. There is no post yet, so this takes the text itself rather than an
   * id — and it PREFILLS an editable draft: what gets published is always what
   * the author approved, never a machine translation nobody read.
   */
  async translateDraft(text: string, targetLanguage: string): Promise<string> {
    const response = await authenticatedClient.post<{ translatedText: string }>(
      '/posts/translate-draft',
      { text, targetLanguage },
    );
    return response.data.translatedText;
  }

  /**
   * Get post by ID
   */
  async getPostById(
    postId: string,
    signal?: AbortSignal,
  ): Promise<HydratedPost> {
    try {
      return await makeViewerAwarePublicRead<HydratedPost>(
        `/feed/item/${postId}`,
        { signal },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      // The feed-item endpoint may legitimately 404 for non-feed posts; fall
      // back to the posts endpoint. Log so a non-404 failure is observable.
      logger.debug('Feed-item lookup failed, falling back to /posts', {
        postId,
        ...normalizeApiError(error),
      });
    }
    return await makeViewerAwarePublicRead<HydratedPost>(
      `/posts/${postId}`,
      { signal },
    );
  }

  /**
   * Get the author's self-thread continuation spine for a root post — the
   * ordered (root-first) chain of the OP's own continuation posts that hang off
   * the root (root → c1 → c2 …). Returns `[]` for any post that is not a
   * self-thread root (a plain post, a reply, a mid-thread continuation, or a
   * boost), so the post-detail screen can call it unconditionally and leave
   * non-thread posts unchanged. Viewer-aware so engagement/permission state on
   * each continuation reflects the current user.
   */
  async getThreadContinuations(rootId: string): Promise<HydratedPost[]> {
    const response = await makeViewerAwarePublicRead<{ items?: HydratedPost[] }>(
      `/feed/thread-continuations/${rootId}`,
    );
    return Array.isArray(response.items) ? response.items : [];
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

  async acceptCollabInvite(postId: string): Promise<{ success: boolean; post: HydratedPost | null }> {
    const response = await authenticatedClient.post<{ success?: boolean; post?: HydratedPost }>(
      `/posts/${postId}/collaborators/accept`,
    );
    return { success: true, post: response?.data?.post ?? null };
  }

  async declineCollabInvite(postId: string): Promise<{ success: boolean; post: HydratedPost | null }> {
    const response = await authenticatedClient.post<{ success?: boolean; post?: HydratedPost }>(
      `/posts/${postId}/collaborators/decline`,
    );
    return { success: true, post: response?.data?.post ?? null };
  }

  async stopCollabSharing(postId: string): Promise<{ success: boolean; post: HydratedPost | null }> {
    const response = await authenticatedClient.post<{ success?: boolean; post?: HydratedPost }>(
      `/posts/${postId}/collaborators/stop-sharing`,
    );
    return { success: true, post: response?.data?.post ?? null };
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
   * Get the likers of a post that the viewer follows — the post-detail social
   * proof row. Viewer-scoped: an anonymous caller gets an empty result (200).
   */
  async getKnownPostLikers(postId: string): Promise<PostKnownLikersResponse> {
    const response = await authenticatedClient.get<PostKnownLikersResponse>(`/posts/${postId}/likes/known`);
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

    // Dedup in-flight within one exact viewer generation. Authenticated accounts
    // must never share personalized hydration merely because both are `auth`.
    // Page size remains part of the key because the profile media grid and feed
    // can request the same descriptor with different limits.
    const cacheKey = `mtn|${requestIdentityDedupeMarker()}|${descriptor}|${options?.cursor || 'initial'}|${options?.limit ?? 'default'}`;

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
      // Read BEFORE the request goes out, and again after it lands: this is the
      // account the server actually authorized (decoded from the bearer the
      // request carried), and a change across the round trip means a switch
      // raced it. `syncFeedWidget` refuses to attribute the page in that case.
      const viewerIdBefore = readViewerId();
      const response = await makeViewerAwarePublicRead<FeedDataResponse>('/feed/mtn', {
        params,
        signal: options?.signal,
      });
      const feed = hasFeedDataEnvelope(response) ? response.data : response;

      // Hand the page to whichever home-screen widget draws this feed. Costs no
      // request — the app already has the posts — and is a no-op off Android,
      // for every other descriptor, past the first page, and when the widget is
      // not placed. Never awaited: nothing the app renders depends on it.
      const viewerIdAfter = readViewerId();
      syncFeedWidget(
        {
          descriptor,
          cursor: options?.cursor,
          viewerIdBefore,
          viewerIdAfter,
          postCount: feed.items?.length ?? 0,
        },
        feed.items ?? [],
      );

      // And the other direction: the following widget is fed by the handoff
      // above only when the reader opens the Following tab, which home does not
      // default to — so if one is PLACED and its batch has gone stale, fetch the
      // timeline for it. Unlike the handoff this spends a request; both gates
      // live natively (`followingWidgetNeedsFeed`) and answer `false` for
      // anyone without the widget. Never awaited.
      prefetchFollowingWidgetFeed({
        descriptor,
        cursor: options?.cursor,
        viewerId: viewerIdAfter,
        fetchFollowingPage: () =>
          this.getMtnFeed('following', { limit: MAX_WIDGET_HANDOFF_POSTS }),
      });

      return feed;
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
   * Send a BATCH of feed interactions.
   *
   * Batched, never one-per-event: a feed reports many rows in a single pass, and
   * one request per row put a scrolling client over the backend's per-IP feed
   * rate limiter, which rejected the overflow and lost the ranking signal.
   * Batching is owned by `utils/feedTelemetry.ts`; this method is the transport.
   */
  async sendFeedInteractions(interactions: FeedInteractionInput[]): Promise<void> {
    if (interactions.length === 0) return;
    try {
      await authenticatedClient.post('/feed/mtn/interactions', { interactions });
    } catch (error) {
      // Telemetry write — non-critical to the user, but log so silent loss of
      // feed-ranking signal is observable in diagnostics.
      logger.debug('Failed to send feed interactions', {
        count: interactions.length,
        ...normalizeApiError(error),
      });
    }
  }

  /**
   * Report what a viewer did with a recommendation card.
   *
   * A SEPARATE route from `sendFeedInteractions` on purpose: that one carries a
   * `postUri` and feeds post ranking, so a card event sent through it would
   * credit author/topic affinity with engagement that never touched a post.
   * Card events are counters about the CARDS, and nothing else reads them.
   */
  async sendInterstitialEvent(data: FeedInterstitialEventInput): Promise<void> {
    try {
      await authenticatedClient.post('/feed/mtn/interstitial-events', data);
    } catch (error) {
      // Same contract as feed interactions: a lost telemetry write must never
      // reach the user, but it stays visible in diagnostics.
      logger.debug('Failed to send interstitial event', {
        event: data.event,
        kind: data.kind,
        ...normalizeApiError(error),
      });
    }
  }

  // ────────────────────────────────────────────────────────────
  // Cross-network connectors — resolve / follow / unfollow
  // ────────────────────────────────────────────────────────────

  /**
   * Resolve a remote handle to a normalized external actor across networks
   * (`GET /federation/resolve`). Returns `null` when the query is a local Oxy
   * handle (404 "Not an external handle") or no actor was found — callers fall
   * back to the existing local people search. Network errors propagate so React
   * Query can surface a retryable error state.
   */
  async resolveExternalActor(handle: string): Promise<ExternalActorResolution | null> {
    try {
      const response = await authenticatedClient.get<ExternalActorResolution>('/federation/resolve', {
        params: { handle },
      });
      return response.data ?? null;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  /**
   * Follow a remote actor across any network (`POST /federation/follow`,
   * dispatched by the actor's protocol). `actorUri` is the actor's canonical
   * protocol id (`externalId` from a resolve): an ActivityPub actor URI or an
   * atproto DID. The response echoes the CANONICAL `actorUri` the system stored.
   */
  async followFederatedActor(actorUri: string): Promise<{ success: boolean; pending: boolean; actorUri: string }> {
    const response = await authenticatedClient.post<{ success: boolean; pending: boolean; actorUri: string }>('/federation/follow', { actorUri });
    return response.data;
  }

  async unfollowFederatedActor(actorUri: string): Promise<{ success: boolean; actorUri: string }> {
    const response = await authenticatedClient.post<{ success: boolean; actorUri: string }>('/federation/unfollow', { actorUri });
    return response.data;
  }
}

export const feedService = new FeedService();
