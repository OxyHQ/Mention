import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { useMemo } from 'react';
import {
  FeedRequest,
  CreateReplyRequest,
  CreateRepostRequest,
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
  primeActorsFromPosts,
  getDb,
  rowToFeedItem,
} from '@/db';
import type { FeedItem, FeedMetaData } from '@/db';

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

type TransformOptions = { skipRelated?: boolean };

const transformToUIItem = (raw: HydratedPost | HydratedPostSummary | any, options: TransformOptions = {}): FeedItem => {
  if (!raw) return raw;

  const id = normalizeId(raw);

  const viewerState = {
    isOwner: raw?.viewerState?.isOwner ?? false,
    isLiked: raw?.viewerState?.isLiked ?? raw?.isLiked ?? false,
    isDownvoted: raw?.viewerState?.isDownvoted ?? raw?.isDownvoted ?? false,
    isReposted: raw?.viewerState?.isReposted ?? raw?.isReposted ?? false,
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
    reposts: raw?.engagement?.reposts !== undefined ? raw.engagement.reposts : raw?.stats?.repostsCount ?? 0,
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
  const displayName = user.displayName || user.name || user.handle || 'User';
  const avatarUrl = user.avatarUrl || user.avatar || '';

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
      displayName,
      name: displayName,
      avatarUrl,
      avatar: avatarUrl,
      handle: user.handle || '',
      badges: user.badges,
      isVerified: user.isVerified,
      id: user.id || '',
    },
    date: metadata.createdAt,
    isLiked: viewerState.isLiked,
    isDownvoted: viewerState.isDownvoted,
    isSaved: viewerState.isSaved,
    isReposted: viewerState.isReposted,
    mediaIds,
    originalMediaIds: (raw as any)?.originalMediaIds ?? undefined,
    allMediaIds: (raw as any)?.allMediaIds ?? (raw as any)?.mediaIds ?? mediaIds,
    original: null,
    quoted: null,
    repost: raw?.repost
      ? {
          ...raw.repost,
          originalPost: raw.repost.originalPost
            ? transformToUIItem(raw.repost.originalPost, { skipRelated: true })
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
  filters?: Record<string, any>;
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
  fetchUserFeed: (userId: string, request: FeedRequest) => Promise<void>;
  fetchSavedPosts: (request: { page?: number; limit?: number }) => Promise<void>;
  refreshFeed: (type: FeedType, filters?: Record<string, any>) => Promise<void>;
  loadMoreFeed: (type: FeedType, filters?: Record<string, any>) => Promise<void>;

  // Content creation
  createPost: (request: CreatePostRequest) => Promise<FeedItem | null>;
  createThread: (request: CreateThreadRequest) => Promise<FeedItem[]>;
  createReply: (request: CreateReplyRequest) => Promise<void>;
  createRepost: (request: CreateRepostRequest) => Promise<void>;
  repostPost: (request: { postId: string }) => Promise<void>;
  unrepostPost: (request: { postId: string }) => Promise<void>;

  // Engagement
  likePost: (request: LikeRequest) => Promise<void>;
  unlikePost: (request: UnlikeRequest) => Promise<void>;
  downvotePost: (request: { postId: string; type: string }) => Promise<void>;
  savePost: (request: { postId: string }) => Promise<void>;
  unsavePost: (request: { postId: string }) => Promise<void>;
  getPostById: (postId: string) => Promise<any>;

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

      // Debounce
      const pending = pendingRequests.get(requestKey);
      if (pending && now - pending.timestamp < 300) return;
      if (pending?.abortController) pending.abortController.abort();

      // Prevent concurrent
      const ui = get().feedUI[feedKey];
      if (ui?.isLoading && !request.cursor) return;

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

        // Write to SQLite — this replaces the entire feed
        dbSetFeedItems(feedKey, items, {
          hasMore: response.hasMore || false,
          nextCursor: response.nextCursor,
          totalCount: items.length,
          lastUpdated: Date.now(),
          filters: request.filters as any,
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
            [feedKey]: { isLoading: false, error: null, lastUpdated: Date.now(), filters: request.filters as any },
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
    fetchUserFeed: async (userId: string, request: FeedRequest) => {
      const { type = 'posts' } = request;
      const feedKey = buildFeedKey(type, userId);

      set((s) => ({
        feedUI: { ...s.feedUI, [feedKey]: { ...defaultFeedUI(), ...s.feedUI[feedKey], isLoading: true, error: null } },
      }));

      try {
        const response = await feedService.getUserFeed(userId, request);
        const items = response.items?.map((item) => transformToUIItem(item)) || [];

        if (request.cursor) {
          // Append mode
          dbAppendFeedItems(feedKey, items, {
            hasMore: response.hasMore || false,
            nextCursor: response.nextCursor,
            totalCount: items.length,
          });
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
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch user feed';
        set((s) => ({
          feedUI: { ...s.feedUI, [feedKey]: { ...s.feedUI[feedKey], isLoading: false, error: errorMessage } },
        }));
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
    refreshFeed: async (type: FeedType, filters?: Record<string, any>) => {
      const feedKey = buildFeedKey(type);
      const ui = get().feedUI[feedKey];
      if (ui?.isLoading) return;

      set((s) => ({
        feedUI: { ...s.feedUI, [feedKey]: { ...defaultFeedUI(), ...s.feedUI[feedKey], isLoading: true, error: null } },
      }));

      try {
        const response = await feedService.getFeed({ type, limit: 20, filters } as any);
        const items = response.items?.map((item) => transformToUIItem(item)) || [];

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
    loadMoreFeed: async (type: FeedType, filters?: Record<string, any>) => {
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
          { type, cursor: cursorAtRequestTime, limit: 20, filters } as any,
          { signal: abortController.signal }
        );

        if (abortController.signal.aborted) return;

        const items = response.items?.map((item) => transformToUIItem(item)) || [];

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
          engagement: { replies: 0, reposts: 0, likes: 0, downvotes: 0, saves: null, views: null, impressions: null },
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
          engagement: { replies: 0, reposts: 0, likes: 0, downvotes: 0, saves: null, views: null, impressions: null },
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

    // ── createRepost ─────────────────────────────────────────
    createRepost: async (request: CreateRepostRequest) => {
      const postId = request.originalPostId;
      let previousPost: FeedItem | null = null;

      set({ isLoading: true, error: null });

      try {
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            engagement: { ...prev.engagement, reposts: (prev.engagement.reposts || 0) + 1 },
          }));
        }

        const response = await feedService.createRepost(request);
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to create repost');
        }
        set({ isLoading: false });
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to create repost';
        set({ isLoading: false, error: errorMessage });
        throw error;
      }
    },

    // ── repostPost ───────────────────────────────────────────
    repostPost: async (request: { postId: string }) => {
      const postId = request.postId;
      let previousPost: FeedItem | null = null;

      try {
        markLocalAction(postId, 'repost');
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            isReposted: true,
            viewerState: { ...prev.viewerState, isReposted: true },
            engagement: { ...prev.engagement, reposts: (prev.engagement.reposts ?? 0) + 1 },
          }));
        }

        const response = await feedService.createRepost({ originalPostId: postId, mentions: [], hashtags: [] });
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to repost');
        }
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to repost';
        set({ error: errorMessage });
        throw error;
      }
    },

    // ── unrepostPost ─────────────────────────────────────────
    unrepostPost: async (request: { postId: string }) => {
      const postId = request.postId;
      let previousPost: FeedItem | null = null;

      try {
        markLocalAction(postId, 'unrepost');
        const currentPost = dbGetPostById(postId);
        if (currentPost) {
          previousPost = { ...currentPost };
          get().updatePostEverywhere(postId, (prev) => ({
            ...prev,
            isReposted: false,
            viewerState: { ...prev.viewerState, isReposted: false },
            engagement: { ...prev.engagement, reposts: Math.max(0, (prev.engagement.reposts ?? 0) - 1) },
          }));
        }

        const response = await feedService.unrepostItem(request);
        if (!response.success) {
          if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
          throw new Error('Failed to unrepost');
        }
      } catch (error) {
        if (previousPost) get().updatePostEverywhere(postId, () => previousPost!);
        const errorMessage = error instanceof Error ? error.message : 'Failed to unrepost';
        set({ error: errorMessage });
        throw error;
      }
    },

    // ── likePost ─────────────────────────────────────────────
    likePost: async (request: LikeRequest) => {
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

        const response = await feedService.voteItem(postId, 1);
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
    savePost: async (request: { postId: string }) => {
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

        const response = await feedService.saveItem(request);
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

      primeActorsFromPosts(transformed);
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
