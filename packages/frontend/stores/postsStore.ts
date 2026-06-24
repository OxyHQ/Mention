import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useMemo } from 'react';
import {
  FeedRequest,
  CreateReplyRequest,
  CreateBoostRequest,
  CreatePostRequest,
  CreateThreadRequest,
  LikeRequest,
  UnlikeRequest,
  FeedType,
  HydratedPost,
  HydratedPostSummary,
  PostAttachmentBundle,
  PostEngagementSummary,
  FeedPostSlice,
} from '@mention/shared-types';
import { createScopedLogger } from '@/lib/logger';
import { feedService } from '../services/feedService';
import { markLocalAction } from '../services/echoGuard';
import { publishNewLocalPost } from '@/stores/feedScrollStore';

// ── Database imports ─────────────────────────────────────────────
import {
  upsertPost as dbUpsertPost,
  upsertPosts as dbUpsertPosts,
  getPostById as dbGetPostById,
  updatePost as dbUpdatePost,
  deletePost as dbDeletePost,
  pruneOldPosts as dbPruneOldPosts,
  setFeedItems as dbSetFeedItems,
  appendFeedItems as dbAppendFeedItems,
  getAllFeedItems as dbGetAllFeedItems,
  getFeedMeta as dbGetFeedMeta,
  clearFeed as dbClearFeed,
  addFeedItemAtStart as dbAddFeedItemAtStart,
  removePostFromAllFeeds as dbRemovePostFromAllFeeds,
  removeFeedItem as dbRemoveFeedItem,
  buildFeedKey,
  getDb,
  rowToFeedItem,
} from '@/db';
import type { FeedItem, FeedMetaData } from '@/db';
import { precacheActorsFromPosts } from '@/lib/precacheActorsFromPosts';
import type { FeedFilters } from '@/utils/feedUtils';

const logger = createScopedLogger('PostsStore');

// ── Shared helpers ───────────────────────────────────────────────

const normalizeId = (item: any): string => {
  if (!item) return '';
  if (item.id != null) return String(item.id);
  if (item._id != null) {
    const _id = item._id;
    return typeof _id === 'object' && typeof _id.toString === 'function'
      ? _id.toString()
      : String(_id);
  }
  if (item._id_str != null) return String(item._id_str);
  if (item.postId != null) return String(item.postId);
  if (item.post?.id != null) return String(item.post.id);
  if (item.post?._id != null) {
    const _id = item.post._id;
    return typeof _id === 'object' && typeof _id.toString === 'function'
      ? _id.toString()
      : String(_id);
  }
  return '';
};

const isValidId = (id: string): boolean =>
  id !== '' && id !== 'undefined' && id !== 'null';

/**
 * Whether a post is a "blank boost" risk-free to cache: it is renderable on its
 * own. A `type:'boost'` post carries an intentionally empty body and is only
 * renderable through its embedded original (`boost.originalPost` / `original`).
 * Any post that is NOT a boost is always renderable here (its own body/media is
 * its content). Used by `cachePosts` so an under-hydrated boost (original lost)
 * can never overwrite an already-hydrated cached boost.
 */
const isRenderableBoost = (item: FeedItem): boolean => {
  // `type`/`boostOf` are not on the hydrated `FeedItem` shape but appear on raw/
  // legacy payloads; read them through a narrow view (no `as any`).
  const probe = item as FeedItem & { type?: string; boostOf?: unknown };
  const isBoost = probe.type === 'boost' || Boolean(item?.boost) || Boolean(probe.boostOf);
  if (!isBoost) return true;
  return Boolean(item?.boost?.originalPost?.id || item?.original?.id);
};

type TransformOptions = { skipRelated?: boolean };

const transformToUIItem = (raw: HydratedPost | HydratedPostSummary | any, options: TransformOptions = {}): FeedItem => {
  if (!raw) return raw;

  const id = normalizeId(raw);

  const viewerState = {
    isOwner: raw?.viewerState?.isOwner ?? false,
    isLiked: raw?.viewerState?.isLiked ?? raw?.isLiked ?? false,
    isDownvoted: raw?.viewerState?.isDownvoted ?? raw?.isDownvoted ?? false,
    isBoosted: raw?.viewerState?.isBoosted ?? raw?.isBoosted ?? false,
    isSaved: raw?.viewerState?.isSaved ?? raw?.isSaved ?? false,
  };

  const permissions = raw?.permissions ?? {
    canReply: true,
    canDelete: false,
    canPin: false,
    canViewSources: Boolean(raw?.attachments?.sources?.length || raw?.content?.sources?.length),
    canEdit: false,
  };

  const engagement: PostEngagementSummary = {
    likes: raw?.engagement?.likes !== undefined ? raw.engagement.likes : raw?.stats?.likesCount ?? 0,
    downvotes: raw?.engagement?.downvotes !== undefined ? raw.engagement.downvotes : raw?.stats?.downvotesCount ?? 0,
    boosts: raw?.engagement?.boosts !== undefined ? raw.engagement.boosts : raw?.stats?.boostsCount ?? 0,
    replies: raw?.engagement?.replies !== undefined ? raw.engagement.replies : raw?.stats?.commentsCount ?? 0,
    saves: raw?.engagement?.saves ?? null,
    views: raw?.engagement?.views ?? null,
    impressions: raw?.engagement?.impressions ?? null,
  };

  const attachments: PostAttachmentBundle = raw?.attachments ?? {
    media: raw?.content?.media,
    poll: raw?.content?.poll,
    article: raw?.content?.article,
    sources: raw?.content?.sources,
    location: raw?.content?.location,
    event: raw?.content?.event,
    room: raw?.content?.room ?? raw?.content?.space,
  };

  const user = raw?.user ?? {};

  const metadata = {
    ...raw?.metadata,
    createdAt: raw?.metadata?.createdAt || raw?.createdAt || raw?.date || new Date().toISOString(),
    updatedAt: raw?.metadata?.updatedAt || raw?.updatedAt || raw?.metadata?.createdAt || raw?.createdAt || new Date().toISOString(),
  };

  const mediaIds = attachments.media?.map((item: any) =>
    typeof item === 'string' ? item : item?.id
  ).filter(Boolean) ?? [];

  const base: FeedItem = {
    ...(raw as HydratedPost),
    id,
    content: raw?.content ?? { text: '' },
    viewerState,
    permissions,
    engagement,
    attachments,
    metadata,
    linkPreview: raw?.linkPreview ?? null,
    user: {
      ...user,
      avatar: user.avatarUrl ?? user.avatar,
      handle: user.handle || '',
      badges: user.badges,
      isVerified: user.isVerified,
      id: user.id || '',
    },
    date: metadata.createdAt,
    isLiked: viewerState.isLiked,
    isDownvoted: viewerState.isDownvoted,
    isSaved: viewerState.isSaved,
    isBoosted: viewerState.isBoosted,
    mediaIds,
    originalMediaIds: (raw as any)?.originalMediaIds ?? undefined,
    allMediaIds: (raw as any)?.allMediaIds ?? (raw as any)?.mediaIds ?? mediaIds,
    original: null,
    quoted: null,
    boost: raw?.boost
      ? {
          ...raw.boost,
          originalPost: raw.boost.originalPost
            ? transformToUIItem(raw.boost.originalPost, { skipRelated: true })
            : null,
        }
      : null,
  } as FeedItem;

  if (!options.skipRelated) {
    const originalSource = raw?.originalPost ?? (raw as any)?.original;
    if (originalSource) {
      base.original = transformToUIItem(originalSource, { skipRelated: true });
    }
    const quotedSource = raw?.quotedPost ?? (raw as any)?.quoted;
    if (quotedSource) {
      base.quoted = transformToUIItem(quotedSource, { skipRelated: true });
    }
  }

  return base;
};

// ── Request tracking ─────────────────────────────────────────────

const pendingRequests = new Map<string, { timestamp: number; abortController?: AbortController }>();
const inFlightEngagements = new Map<string, string>();
const getEngagementKey = (postId: string, action: string) => `${postId}:${action.replace('un', '')}`;

// ── Sync vote state from server ──────────────────────────────────

const syncVoteStateFromServer = (
  get: () => PostsStoreState,
  postId: string,
  responseData: unknown
) => {
  const data = responseData as Record<string, unknown> | undefined;
  const serverLikesCount = data?.likesCount as number | undefined;
  const serverDownvotesCount = data?.downvotesCount as number | undefined;
  const serverLiked = data?.liked === true;
  const serverDownvoted = data?.downvoted === true;

  if (serverLikesCount !== undefined) {
    get().updatePostEverywhere(postId, (prev) => ({
      ...prev,
      isLiked: serverLiked,
      isDownvoted: serverDownvoted,
      viewerState: { ...prev.viewerState, isLiked: serverLiked, isDownvoted: serverDownvoted },
      engagement: {
        ...prev.engagement,
        likes: serverLikesCount,
        downvotes: serverDownvotesCount ?? prev.engagement.downvotes,
      },
    }));
  }
};

// ── Store types ──────────────────────────────────────────────────

interface FeedSliceUI {
  isLoading: boolean;
  error: string | null;
  lastUpdated: number;
  filters?: FeedFilters;
}

interface PostsStoreState {
  // Reactive version counter — bumped on every data mutation to trigger re-reads
  dataVersion: number;

  // UI state per feed key (loading/error only — data lives in SQLite)
  feedUI: Record<string, FeedSliceUI>;

  // Global UI state
  isLoading: boolean;
  error: string | null;
  lastRefresh: number;

  // Feed operations
  fetchFeed: (request: FeedRequest) => Promise<void>;
  fetchUserFeed: (userId: string, request: FeedRequest) => Promise<{ pending: boolean }>;
  fetchSavedPosts: (request: { page?: number; limit?: number }) => Promise<void>;
  refreshFeed: (type: FeedType, filters?: FeedFilters) => Promise<void>;
  loadMoreFeed: (type: FeedType, filters?: FeedFilters) => Promise<void>;

  // Content creation
  createPost: (request: CreatePostRequest) => Promise<FeedItem | null>;
  createThread: (request: CreateThreadRequest) => Promise<FeedItem[]>;
  createReply: (request: CreateReplyRequest) => Promise<void>;
  createBoost: (request: CreateBoostRequest) => Promise<void>;
  // `source` (optional) is the originating feed descriptor for surface-aware
  // engagement attribution. Threaded only through the POSITIVE actions (boost,
  // like, save) — the undo actions carry no interest signal.
  boostPost: (request: { postId: string }, source?: string) => Promise<void>;
  unboostPost: (request: { postId: string }) => Promise<void>;

  // Engagement
  likePost: (request: LikeRequest, source?: string) => Promise<void>;
  unlikePost: (request: UnlikeRequest) => Promise<void>;
  downvotePost: (request: { postId: string; type: string }) => Promise<void>;
  savePost: (request: { postId: string }, source?: string) => Promise<void>;
  unsavePost: (request: { postId: string }) => Promise<void>;
  getPostById: (postId: string) => Promise<any>;
  // Always fetch a single post from the network and upsert it into the shared
  // cache (stale-while-revalidate). Unlike `getPostById`, this does NOT short-
  // circuit on a cache hit — it refreshes engagement/viewer state for an
  // already-cached post (e.g. when the post-detail screen opens from the feed).
  revalidatePostById: (postId: string) => Promise<FeedItem | null>;
  // Upsert post objects into the shared cache WITHOUT touching feed ordering.
  // Used by the memory-mode feed path (web without SQLite, and scoped feeds),
  // which owns its own ordering in local React state but must still seed the
  // shared post cache so the post-detail screen can render instantly from
  // `getPostFromDb(id)` instead of issuing a cold blocking fetch on open.
  cachePosts: (posts: (HydratedPost | HydratedPostSummary)[]) => void;

  // Local state updates
  updatePostLocally: (postId: string, updates: Partial<FeedItem>) => void;
  updatePostEverywhere: (postId: string, updater: (prev: FeedItem) => FeedItem | null | undefined) => void;
  removePostEverywhere: (postId: string) => void;
  removePostLocally: (postId: string, feedType: FeedType) => void;
  addPostToFeed: (post: FeedItem, feedType: FeedType) => void;
  addPostsToFeed: (posts: FeedItem[], feedType: FeedType) => void;

  // Utility
  clearError: () => void;
  clearFeed: (type: FeedType) => void;
  clearUserFeed: (userId: string, type: FeedType) => void;
  prunePostsCache: () => void;

  // SQLite data accessors (synchronous reads)
  getFeedItemsFromDb: (feedKey: string) => FeedItem[];
  getFeedMetaFromDb: (feedKey: string) => FeedMetaData | null;
  getPostFromDb: (postId: string) => FeedItem | null;
}

// ── Helper to bump version ───────────────────────────────────────

const bumpVersion = (state: PostsStoreState) => ({ dataVersion: state.dataVersion + 1 });

// ── Default feed UI state ────────────────────────────────────────

const defaultFeedUI = (): FeedSliceUI => ({
  isLoading: false,
  error: null,
  lastUpdated: 0,
});

// ── Store ────────────────────────────────────────────────────────

export const usePostsStore = create<PostsStoreState>()(
  subscribeWithSelector((set, get) => ({
    dataVersion: 0,
    feedUI: {},
    isLoading: false,
    error: null,
    lastRefresh: Date.now(),

    // ── SQLite data accessors ────────────────────────────────
    getFeedItemsFromDb: (feedKey: string) => dbGetAllFeedItems(feedKey),
    getFeedMetaFromDb: (feedKey: string) => dbGetFeedMeta(feedKey),
    getPostFromDb: (postId: string) => dbGetPostById(postId),

    // ── fetchFeed ────────────────────────────────────────────
    fetchFeed: async (request: FeedRequest) => {
      const { type = 'mixed' } = request;
      const feedKey = buildFeedKey(type);
      const requestKey = `${type}:${request.cursor || 'initial'}`;
      const now = Date.now();

      // Debounce: collapse a rapid repeat of the same request (e.g. an effect
      // firing twice in quick succession) into the in-flight one.
      const pending = pendingRequests.get(requestKey);
      if (pending && now - pending.timestamp < 300) return;

      // A later request for the same key supersedes the in-flight one (e.g. the
      // feed hook remounted mid-load and re-issued the initial fetch). Abort the
      // prior request AND mark that we superseded it, so the concurrent guard
      // below does not then refuse to start the replacement — otherwise we'd
      // cancel the only running request and never issue a new one, stranding the
      // feed empty.
      const supersededPrior = !!pending?.abortController;
      if (pending?.abortController) pending.abortController.abort();

      // Prevent two independent concurrent loads of the same feed. Skipped when
      // we just superseded the prior request: that request is now aborted, so we
      // are the sole legitimate load and must proceed (its stale `isLoading`
      // flag would otherwise block us).
      const ui = get().feedUI[feedKey];
      if (ui?.isLoading && !request.cursor && !supersededPrior) return;

      const abortController = new AbortController();
      pendingRequests.set(requestKey, { timestamp: now, abortController });

      set((s) => ({
        feedUI: { ...s.feedUI, [feedKey]: { ...defaultFeedUI(), ...s.feedUI[feedKey], isLoading: true, error: null } },
      }));

      try {
        const response = await feedService.getFeed(request, { signal: abortController.signal });
        if (abortController.signal.aborted) return;

        // Verify still latest request
        const latest = pendingRequests.get(requestKey);
        if (!latest || latest.timestamp !== now) return;

        // Transform items
        const items = response.items?.map((item) => transformToUIItem(item)) || [];

        // Prime the React Query actor cache (works web + native, no SQLite)
        precacheActorsFromPosts(items);

        // Write to SQLite — this replaces the entire feed
        dbSetFeedItems(feedKey, items, {
          hasMore: response.hasMore || false,
          nextCursor: response.nextCursor,
          totalCount: items.length,
          lastUpdated: Date.now(),
          filters: request.filters,
        });

        // Also persist related posts
        for (const item of items) {
          if (item.original?.id) dbUpsertPost(item.original);
          if (item.quoted?.id) dbUpsertPost(item.quoted);
        }

        // Bump version to trigger re-reads + update UI state
        set((s) => ({
          ...bumpVersion(s),
          feedUI: {
            ...s.feedUI,
            [feedKey]: { isLoading: false, error: null, lastUpdated: Date.now(), filters: request.filters },
          },
          lastRefresh: Date.now(),
        }));

        // Background prune
        dbPruneOldPosts();
      } catch (error) {
        if (abortController.signal.aborted) return;
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch feed';
        set((s) => ({
          feedUI: { ...s.feedUI, [feedKey]: { ...s.feedUI[feedKey], isLoading: false, error: errorMessage } },
          error: errorMessage,
        }));
      } finally {
        const current = pendingRequests.get(requestKey);
        if (current && current.timestamp === now) pendingRequests.delete(requestKey);
      }
    },

    // ── fetchUserFeed ────────────────────────────────────────
    // Returns `{ pending }` so callers can drive a bounded refetch while a
    // federated user's outbox is still syncing in the background.
    fetchUserFeed: async (userId: string, request: FeedRequest) => {
      const { type = 'posts' } = request;
      const feedKey = buildFeedKey(type, userId);

      set((s) => ({
        feedUI: { ...s.feedUI, [feedKey]: { ...defaultFeedUI(), ...s.feedUI[feedKey], isLoading: true, error: null } },
      }));

      try {
        const response = await feedService.getUserFeed(userId, request);
        const items = response.items?.map((item) => transformToUIItem(item)) || [];
        const isPendingEmptyInitialLoad = !request.cursor && response.pending === true && items.length === 0;

        // Prime the React Query actor cache (works web + native, no SQLite)
        precacheActorsFromPosts(items);

        if (request.cursor) {
          // Append mode
          dbAppendFeedItems(feedKey, items, {
            hasMore: response.hasMore || false,
            nextCursor: response.nextCursor,
            totalCount: items.length,
          });
        } else if (isPendingEmptyInitialLoad && dbGetFeedMeta(feedKey)?.lastUpdated) {
          // Keep the visible cached profile feed while the backend finishes
          // federated outbox sync. Replacing it with [] causes cold-boot profile
          // feeds to appear wiped until the next successful poll.
        } else {
          // Replace mode
          dbSetFeedItems(feedKey, items, {
            hasMore: response.hasMore || false,
            nextCursor: response.nextCursor,
            totalCount: items.length,
            lastUpdated: Date.now(),
          });
        }

        set((s) => ({
          ...bumpVersion(s),
          feedUI: { ...s.feedUI, [feedKey]: { isLoading: false, error: null, lastUpdated: Date.now() } },
        }));

        return { pending: response.pending === true && items.length === 0 };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch user feed';
        set((s) => ({
          feedUI: { ...s.feedUI, [feedKey]: { ...s.feedUI[feedKey], isLoading: false, error: errorMessage } },
        }));
        return { pending: false };
      }
    },

    // ── fetchSavedPosts ──────────────────────────────────────
    fetchSavedPosts: async (request = {}) => {
      const feedKey = buildFeedKey('saved');

      set((s) => ({
        feedUI: { ...s.feedUI, [feedKey]: { ...defaultFeedUI(), ...s.feedUI[feedKey], isLoading: true, error: null } },
      }));

      try {
        const response = await feedService.getSavedPosts(request);
        let processedPosts = (response.data as any).posts?.map((post: any) => transformToUIItem({ ...post, isSaved: true })) || [];

        // Fallback: derive from SQLite saved posts
        if (!processedPosts.length) {
          const sqliteDb = getDb();
          if (sqliteDb) {
            const savedFromDb = sqliteDb.getAllSync<any>(
              'SELECT * FROM posts WHERE is_saved = 1 ORDER BY created_at DESC LIMIT 50'
            );
            if (savedFromDb.length) {
              processedPosts = savedFromDb.map(rowToFeedItem);
            }
          }
        }

        // Prime the React Query actor cache (works web + native, no SQLite)
        precacheActorsFromPosts(processedPosts);

        dbSetFeedItems(feedKey, processedPosts, {
          hasMore: (response.data as any).hasMore || false,
          totalCount: processedPosts.length,
          lastUpdated: Date.now(),
        });

        set((s) => ({
          ...bumpVersion(s),
          feedUI: { ...s.feedUI, [feedKey]: { isLoading: false, error: null, lastUpdated: Date.now() } },
          lastRefresh: Date.now(),
        }));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch saved posts';
        set((s) => ({
          feedUI: { ...s.feedUI, [feedKey]: { ...s.feedUI[feedKey], isLoading: false, error: errorMessage } },
          error: errorMessage,
        }));
      }
    },

    // ── refreshFeed ──────────────────────────────────────────
    refreshFeed: async (type: FeedType, filters?: FeedFilters) => {
      const feedKey = buildFeedKey(type);
      const ui = get().feedUI[feedKey];
      if (ui?.isLoading) return;

      set((s) => ({
        feedUI: { ...s.feedUI, [feedKey]: { ...defaultFeedUI(), ...s.feedUI[feedKey], isLoading: true, error: null } },
      }));

      try {
        const response = await feedService.getFeed({ type, limit: 20, filters });
        const items = response.items?.map((item) => transformToUIItem(item)) || [];

        // Prime the React Query actor cache (works web + native, no SQLite)
        precacheActorsFromPosts(items);

        dbSetFeedItems(feedKey, items, {
          hasMore: response.hasMore || false,
          nextCursor: response.nextCursor,
          totalCount: items.length,
          lastUpdated: Date.now(),
        });

        // Persist related posts
        for (const item of items) {
          if (item.original?.id) dbUpsertPost(item.original);
          if (item.quoted?.id) dbUpsertPost(item.quoted);
        }

        set((s) => ({
          ...bumpVersion(s),
          feedUI: { ...s.feedUI, [feedKey]: { isLoading: false, error: null, lastUpdated: Date.now() } },
          lastRefresh: Date.now(),
        }));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to refresh feed';
        set((s) => ({
          feedUI: { ...s.feedUI, [feedKey]: { ...s.feedUI[feedKey], isLoading: false, error: errorMessage } },
        }));
      }
    },

    // ── loadMoreFeed ─────────────────────────────────────────
    loadMoreFeed: async (type: FeedType, filters?: FeedFilters) => {
      const feedKey = buildFeedKey(type);
      const ui = get().feedUI[feedKey];
      const meta = dbGetFeedMeta(feedKey);

      if (ui?.isLoading || !meta?.hasMore) return;
      if (!meta?.nextCursor) return;

      const requestKey = `${type}:loadMore:${meta.nextCursor}`;
      const now = Date.now();

      const pending = pendingRequests.get(requestKey);
      if (pending && now - pending.timestamp < 500) return;
      if (pending?.abortController) pending.abortController.abort();

      const abortController = new AbortController();
      pendingRequests.set(requestKey, { timestamp: now, abortController });

      set((s) => ({
        feedUI: { ...s.feedUI, [feedKey]: { ...s.feedUI[feedKey], isLoading: true } },
      }));

      try {
        const cursorAtRequestTime = meta.nextCursor;
        const response = await feedService.getFeed(
          { type, cursor: cursorAtRequestTime, limit: 20, filters },
          { signal: abortController.signal }
        );

        if (abortController.signal.aborted) return;

        const items = response.items?.map((item) => transformToUIItem(item)) || [];

        // Prime the React Query actor cache (works web + native, no SQLite)
        precacheActorsFromPosts(items);

        // Append to SQLite — dedup handled by PRIMARY KEY
        dbAppendFeedItems(feedKey, items, {
          hasMore: response.hasMore || false,
          nextCursor: response.nextCursor,
          totalCount: items.length,
        });

        // Persist related posts
        for (const item of items) {
          if (item.original?.id) dbUpsertPost(item.original);
          if (item.quoted?.id) dbUpsertPost(item.quoted);
        }

        set((s) => ({
          ...bumpVersion(s),
          feedUI: { ...s.feedUI, [feedKey]: { ...s.feedUI[feedKey], isLoading: false, lastUpdated: Date.now() } },
        }));
      } catch (error) {
        if (abortController.signal.aborted) return;
        const errorMessage = error instanceof Error ? error.message : 'Failed to load more feed';
        set((s) => ({
          feedUI: { ...s.feedUI, [feedKey]: { ...s.feedUI[feedKey], isLoading: false, error: errorMessage } },
        }));
      } finally {
        pendingRequests.delete(requestKey);
      }
    },

    // ── createPost ───────────────────────────────────────────
    createPost: async (request: CreatePostRequest) => {
      set({ isLoading: true, error: null });

      try {
        const response = await feedService.createPost(request);
        if (!response.success) { set({ isLoading: false }); return null; }

        const rawPost = (response as any)?.post?.post ?? response.post;
        if (!rawPost) { set({ isLoading: false }); return null; }
        if (rawPost.status === 'scheduled') { set({ isLoading: false }); return rawPost; }

        const newPost: FeedItem = {
          ...transformToUIItem(rawPost),
          engagement: { replies: 0, boosts: 0, likes: 0, downvotes: 0, saves: null, views: null, impressions: null },
          isLocalNew: true,
        };

        // Write to SQLite
        dbUpsertPost(newPost);

        // Add to relevant feeds at position 0
        const feedKeys = ['posts', 'mixed', 'for_you', 'following'];
        for (const key of feedKeys) {
          dbAddFeedItemAtStart(key, newPost.id);
        }

        // Add to user feed if loaded
        const userId = newPost.user?.id;
        if (userId) {
          const userFeedKey = buildFeedKey('posts', userId);
          dbAddFeedItemAtStart(userFeedKey, newPost.id);
        }

        // Memory-mode feeds (web without SQLite) don't read SQLite — broadcast the
        // new post so any mounted in-memory home/profile feed prepends it live.
        publishNewLocalPost(newPost);

        set((s) => ({ ...bumpVersion(s), isLoading: false, lastRefresh: Date.now() }));
        return newPost;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to create post';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // ── createThread ─────────────────────────────────────────
    createThread: async (request: CreateThreadRequest) => {
      set({ isLoading: true, error: null });

      try {
        const response = await feedService.createThread(request);
        if (!response.success || !response.posts) { set({ isLoading: false }); return []; }

        const newPosts: FeedItem[] = response.posts.map((post: any) => ({
          ...transformToUIItem(post),
          engagement: { replies: 0, boosts: 0, likes: 0, downvotes: 0, saves: null, views: null, impressions: null },
          isLocalNew: true,
        }));

        // Write to SQLite
        dbUpsertPosts(newPosts);

        // Add to feeds
        const feedKeys = ['posts', 'mixed', 'for_you', 'following'];
        for (const post of newPosts) {
          for (const key of feedKeys) {
            dbAddFeedItemAtStart(key, post.id);
          }
        }

        const userId = newPosts[0]?.user?.id;
        if (userId) {
          const userFeedKey = buildFeedKey('posts', userId);
          for (const post of newPosts) {
            dbAddFeedItemAtStart(userFeedKey, post.id);
          }
        }

        // Memory-mode feeds (web without SQLite) don't read SQLite — broadcast the
        // thread's lead post so any mounted in-memory home/profile feed prepends it
        // live. The thread renders as one slice headed by the first post.
        if (newPosts[0]) {
          publishNewLocalPost(newPosts[0]);
        }

        set((s) => ({ ...bumpVersion(s), isLoading: false, lastRefresh: Date.now() }));
        return newPosts;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to create thread';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // ── createReply ──────────────────────────────────────────
    createReply: async (request: CreateReplyRequest) => {
      const postId = request.postId;
      let previousPost: FeedItem | null = null;

      set({ isLoading: true, error: null });

      try {
        markLocalAction(postId, 'reply');
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            engagement: { ...prev.engagement, replies: (prev.engagement.replies || 0) + 1 },
          }));
        }

        const response = await feedService.createReply(request);
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to create reply');
        }
        set({ isLoading: false });
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to create reply';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // ── createBoost ──────────────────────────────────────────
    createBoost: async (request: CreateBoostRequest) => {
      const postId = request.originalPostId;
      let previousPost: FeedItem | null = null;

      set({ isLoading: true, error: null });

      try {
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            engagement: { ...prev.engagement, boosts: (prev.engagement.boosts || 0) + 1 },
          }));
        }

        const response = await feedService.createBoost(request);
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to create boost');
        }
        set({ isLoading: false });
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to create boost';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // ── boostPost ────────────────────────────────────────────
    boostPost: async (request: { postId: string }, source?: string) => {
      const postId = request.postId;
      let previousPost: FeedItem | null = null;

      try {
        markLocalAction(postId, 'boost');
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            isBoosted: true,
            viewerState: { ...prev.viewerState, isBoosted: true },
            engagement: { ...prev.engagement, boosts: (prev.engagement.boosts ?? 0) + 1 },
          }));
        }

        const response = await feedService.createBoost({ originalPostId: postId, mentions: [], hashtags: [] }, source);
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to boost');
        }
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to boost';
        set({ error: errorMessage });
        throw error;
      }
    },

    // ── unboostPost ──────────────────────────────────────────
    unboostPost: async (request: { postId: string }) => {
      const postId = request.postId;
      let previousPost: FeedItem | null = null;

      try {
        markLocalAction(postId, 'unboost');
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            isBoosted: false,
            viewerState: { ...prev.viewerState, isBoosted: false },
            engagement: { ...prev.engagement, boosts: Math.max(0, (prev.engagement.boosts ?? 0) - 1) },
          }));
        }

        const response = await feedService.unboostItem(request);
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to unboost');
        }
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to unboost';
        set({ error: errorMessage });
        throw error;
      }
    },

    // ── likePost ─────────────────────────────────────────────
    likePost: async (request: LikeRequest, source?: string) => {
      const postId = request.postId;
      const engagementKey = getEngagementKey(postId, 'like');
      let previousPost: FeedItem | null = null;

      if (inFlightEngagements.has(engagementKey)) return;
      inFlightEngagements.set(engagementKey, 'like');

      try {
        markLocalAction(postId, 'like');
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          if (!currentPost.isLiked) {
            get().updatePostEverywhere(postId, (prev) => ({
              ...prev,
              isLiked: true,
              viewerState: { ...prev.viewerState, isLiked: true },
              engagement: { ...prev.engagement, likes: (prev.engagement.likes ?? 0) + 1 },
            }));
          }
        }

        const response = await feedService.voteItem(postId, 1, source);
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to like');
        }
        syncVoteStateFromServer(get, postId, response.data);
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to like';
        set({ error: errorMessage });
        throw error;
      } finally {
        inFlightEngagements.delete(engagementKey);
      }
    },

    // ── unlikePost ───────────────────────────────────────────
    unlikePost: async (request: UnlikeRequest) => {
      const postId = request.postId;
      const engagementKey = getEngagementKey(postId, 'unlike');
      let previousPost: FeedItem | null = null;

      if (inFlightEngagements.has(engagementKey)) return;
      inFlightEngagements.set(engagementKey, 'unlike');

      try {
        markLocalAction(postId, 'unlike');
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          if (currentPost.isLiked) {
            get().updatePostEverywhere(postId, (prev) => ({
              ...prev,
              isLiked: false,
              viewerState: { ...prev.viewerState, isLiked: false },
              engagement: { ...prev.engagement, likes: Math.max(0, (prev.engagement.likes ?? 0) - 1) },
            }));
          }
        }

        const response = await feedService.removeVote(postId);
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to unlike');
        }
        syncVoteStateFromServer(get, postId, response.data);
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to unlike';
        set({ error: errorMessage });
        throw error;
      } finally {
        inFlightEngagements.delete(engagementKey);
      }
    },

    // ── downvotePost ─────────────────────────────────────────
    downvotePost: async (request: { postId: string; type: string }) => {
      const postId = request.postId;
      const engagementKey = getEngagementKey(postId, 'downvote');
      let previousPost: FeedItem | null = null;

      if (inFlightEngagements.has(engagementKey)) return;
      inFlightEngagements.set(engagementKey, 'downvote');

      try {
        markLocalAction(postId, 'downvote');
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          if (!currentPost.isDownvoted) {
            const wasLiked = currentPost.isLiked;
            get().updatePostEverywhere(postId, (prev) => ({
              ...prev,
              isLiked: false,
              isDownvoted: true,
              viewerState: { ...prev.viewerState, isLiked: false, isDownvoted: true },
              engagement: {
                ...prev.engagement,
                likes: wasLiked ? Math.max(0, (prev.engagement.likes ?? 0) - 1) : prev.engagement.likes,
                downvotes: (prev.engagement.downvotes ?? 0) + 1,
              },
            }));
          }
        }

        const response = await feedService.voteItem(postId, -1);
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to downvote');
        }
        syncVoteStateFromServer(get, postId, response.data);
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to downvote';
        set({ error: errorMessage });
        throw error;
      } finally {
        inFlightEngagements.delete(engagementKey);
      }
    },

    // ── savePost ─────────────────────────────────────────────
    savePost: async (request: { postId: string }, source?: string) => {
      const postId = request.postId;
      let previousPost: FeedItem | null = null;

      try {
        markLocalAction(postId, 'save');
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            isSaved: true,
            viewerState: { ...prev.viewerState, isSaved: true },
          }));
        }

        const response = await feedService.saveItem(request, source);
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to save');
        }
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to save';
        set({ error: errorMessage });
        throw error;
      }
    },

    // ── unsavePost ───────────────────────────────────────────
    unsavePost: async (request: { postId: string }) => {
      const postId = request.postId;
      let previousPost: FeedItem | null = null;

      try {
        markLocalAction(postId, 'unsave');
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            isSaved: false,
            viewerState: { ...prev.viewerState, isSaved: false },
          }));
        }

        const response = await feedService.unsaveItem(request);
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to unsave');
        }
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to unsave';
        set({ error: errorMessage });
        throw error;
      }
    },

    // ── getPostById ──────────────────────────────────────────
    getPostById: async (postId: string) => {
      try {
        // Check SQLite first
        const cached = dbGetPostById(postId);
        if (cached) return cached;

        // Fetch from API
        const response = await feedService.getPostById(postId);
        const item = transformToUIItem(response);
        dbUpsertPost(item);
        if (item.original?.id) dbUpsertPost(item.original);
        if (item.quoted?.id) dbUpsertPost(item.quoted);
        set((s) => bumpVersion(s));
        return item;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch post';
        set({ error: errorMessage });
        throw error;
      }
    },

    // ── revalidatePostById ───────────────────────────────────
    revalidatePostById: async (postId: string) => {
      if (!postId) return null;
      try {
        const response = await feedService.getPostById(postId);
        const item = transformToUIItem(response);
        if (!isValidId(item.id)) return null;
        dbUpsertPost(item);
        if (item.original?.id) dbUpsertPost(item.original);
        if (item.quoted?.id) dbUpsertPost(item.quoted);
        set((s) => bumpVersion(s));
        return item;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to revalidate post';
        logger.debug('revalidatePostById failed', { postId, error: errorMessage });
        return null;
      }
    },

    // ── cachePosts ───────────────────────────────────────────
    // Seed the shared post cache from the memory-mode feed path. Transforms raw
    // feed items into the canonical UI shape (so the detail screen reads the same
    // shape the SQLite path produces) and upserts them — plus any embedded
    // original/quoted posts — without writing feed_items, so memory mode's own
    // ordering in local React state is untouched.
    cachePosts: (posts: (HydratedPost | HydratedPostSummary)[]) => {
      if (!posts || posts.length === 0) return;

      const transformed = posts
        .map((p) => transformToUIItem(p))
        .filter((p) => isValidId(p.id))
        // Defense-in-depth: a `type:'boost'` post has an empty body and is only
        // renderable via its embedded original. If an incoming copy lost that
        // original (an under-hydrated response from some endpoint) but the cached
        // copy still HAS it, keep the cached one — never let a blank boost
        // clobber a hydrated boost in the shared cache. The backend now always
        // embeds the boost original (PostHydrationService), so this is a guard
        // against future regressions, not the primary fix.
        .filter((item) => {
          if (isRenderableBoost(item)) return true;
          const cached = dbGetPostById(item.id);
          // Drop the under-hydrated incoming copy only when the cached copy is a
          // strictly-better (renderable) boost; otherwise let it through.
          return !(cached && isRenderableBoost(cached));
        });
      if (transformed.length === 0) return;

      dbUpsertPosts(transformed);
      for (const item of transformed) {
        if (item.original?.id) dbUpsertPost(item.original);
        if (item.quoted?.id) dbUpsertPost(item.quoted);
      }
      set((s) => bumpVersion(s));
    },

    // ── updatePostLocally ────────────────────────────────────
    updatePostLocally: (postId: string, updates: Partial<FeedItem>) => {
      dbUpdatePost(postId, (prev) => ({ ...prev, ...updates }));
      set((s) => bumpVersion(s));
    },

    // ── updatePostEverywhere ─────────────────────────────────
    // Now O(1) — single SQLite UPDATE instead of scanning all feeds
    updatePostEverywhere: (postId: string, updater: (prev: FeedItem) => FeedItem | null | undefined) => {
      const result = dbUpdatePost(postId, updater);
      if (result) {
        set((s) => bumpVersion(s));
      }
    },

    // ── removePostEverywhere ─────────────────────────────────
    removePostEverywhere: (postId: string) => {
      dbRemovePostFromAllFeeds(postId);
      dbDeletePost(postId);
      set((s) => bumpVersion(s));
    },

    // ── removePostLocally ────────────────────────────────────
    removePostLocally: (postId: string, feedType: FeedType) => {
      const feedKey = buildFeedKey(feedType);
      dbRemoveFeedItem(feedKey, postId);
      set((s) => bumpVersion(s));
    },

    // ── addPostToFeed ────────────────────────────────────────
    addPostToFeed: (post: FeedItem, feedType: FeedType) => {
      get().addPostsToFeed([post], feedType);
    },

    // ── addPostsToFeed ───────────────────────────────────────
    addPostsToFeed: (posts: FeedItem[], feedType: FeedType) => {
      if (!posts || posts.length === 0) return;

      const feedKey = buildFeedKey(feedType);
      const transformed = posts.map((p) => transformToUIItem(p));
      dbUpsertPosts(transformed);

      for (const post of transformed) {
        dbAddFeedItemAtStart(feedKey, post.id);
      }

      precacheActorsFromPosts(transformed);
      set((s) => bumpVersion(s));
    },

    // ── Utility ──────────────────────────────────────────────
    clearError: () => set({ error: null }),

    clearFeed: (type: FeedType) => {
      const feedKey = buildFeedKey(type);
      dbClearFeed(feedKey);
      set((s) => ({
        ...bumpVersion(s),
        feedUI: { ...s.feedUI, [feedKey]: defaultFeedUI() },
      }));
    },

    clearUserFeed: (userId: string, type: FeedType) => {
      const feedKey = buildFeedKey(type, userId);
      dbClearFeed(feedKey);
      set((s) => ({
        ...bumpVersion(s),
        feedUI: { ...s.feedUI, [feedKey]: defaultFeedUI() },
      }));
    },

    prunePostsCache: () => {
      dbPruneOldPosts();
    },
  }))
);

// ── Compatibility layer ──────────────────────────────────────────
// These selectors provide backwards-compatible access that reads from SQLite.
// Components subscribe to dataVersion changes which trigger re-reads.

export const useFeedSelector = (type: FeedType) => {
  const dataVersion = usePostsStore((s) => s.dataVersion);
  const feedKey = buildFeedKey(type);
  const ui = usePostsStore((s) => s.feedUI[feedKey]);
  const meta = useMemo(() => dbGetFeedMeta(feedKey), [feedKey, dataVersion]);
  const items = useMemo(() => dbGetAllFeedItems(feedKey), [feedKey, dataVersion]);

  return {
    items,
    slices: undefined as FeedPostSlice[] | undefined,
    hasMore: meta?.hasMore ?? true,
    nextCursor: meta?.nextCursor,
    totalCount: meta?.totalCount ?? 0,
    isLoading: ui?.isLoading ?? false,
    error: ui?.error ?? null,
    lastUpdated: ui?.lastUpdated ?? 0,
    filters: ui?.filters,
  };
};

export const useUserFeedSelector = (userId: string, type: FeedType) => {
  const dataVersion = usePostsStore((s) => s.dataVersion);
  const feedKey = buildFeedKey(type, userId);
  const ui = usePostsStore((s) => s.feedUI[feedKey]);
  const meta = useMemo(() => dbGetFeedMeta(feedKey), [feedKey, dataVersion]);
  const items = useMemo(() => dbGetAllFeedItems(feedKey), [feedKey, dataVersion]);

  return {
    items,
    slices: undefined as FeedPostSlice[] | undefined,
    hasMore: meta?.hasMore ?? true,
    nextCursor: meta?.nextCursor,
    totalCount: meta?.totalCount ?? 0,
    isLoading: ui?.isLoading ?? false,
    error: ui?.error ?? null,
    lastUpdated: ui?.lastUpdated ?? 0,
  };
};

export const useFeedLoading = (type: FeedType) => {
  const feedKey = buildFeedKey(type);
  return usePostsStore((s) => s.feedUI[feedKey]?.isLoading ?? false);
};

export const useFeedError = (type: FeedType) => {
  const feedKey = buildFeedKey(type);
  return usePostsStore((s) => s.feedUI[feedKey]?.error ?? null);
};

export const useFeedHasMore = (type: FeedType) => {
  const dataVersion = usePostsStore((s) => s.dataVersion);
  const feedKey = buildFeedKey(type);
  const meta = useMemo(() => dbGetFeedMeta(feedKey), [feedKey, dataVersion]);
  return meta?.hasMore ?? false;
};
