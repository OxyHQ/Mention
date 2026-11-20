import { action, currentStore, source, type Store, withStore } from '@oxy.so/bloom-data';
import { create } from 'zustand';
import type {
  CreateBoostRequest,
  CreatePostRequest,
  CreateReplyRequest,
  CreateThreadRequest,
  FeedPostViewCounts,
  HydratedPost,
  HydratedPostSummary,
  LikeRequest,
  UnlikeRequest,
} from '@mention/shared-types';
import { MAX_POST_ANCESTORS, MAX_POST_BATCH } from '@mention/shared-types/post';
import { createLogger } from '@oxy.so/core/logger';
import type { FeedItem } from '@/db/schema';
import { toFeedItem } from '@/db/feedItem';
import {
  boostPost,
  downvotePost,
  likePost,
  savePost,
  unboostPost,
  unlikePost,
  unsavePost,
} from '@/data/engagement';
import { publishNewLocalPost, publishNewLocalReply } from '@/data/feeds';
import {
  getPost,
  isValidPostId,
  Post,
  PostViews,
  storePosts,
  usePost,
  useViewCount,
} from '@/data/posts';
import { queryClient } from '@/lib/queryClient';
import { markLocalAction } from '@/services/echoGuard';
import { feedService } from '@/services/feedService';
import { invalidateProfileCounts } from '@/stores/profileCountsInvalidation';
import { normalizeApiError } from '@/utils/apiError';

/**
 * The posts API the app's flows call, over the one posts store
 * (`data/posts`, `@oxy.so/bloom-data`).
 *
 * Feeds, the post screen, engagement and realtime read and write `Post`
 * directly. The flows not moved yet (compose, the post menu, insights,
 * notifications…) keep calling these methods while they move; every one of
 * them now writes the same records, so there is one copy of each post and no
 * second path to keep in step. What is left here goes when those flows call
 * `data/` themselves.
 */

const logger = createLogger('PostsStore');

/** A post the server reads for this viewer, by id: one read per id at a time. */
const postSource = source(Post, {
  key: (postId: string) => postId,
  load: async ({ signal }, postId: string) =>
    toFeedItem(await feedService.getPostById(postId, signal)),
  // One retry policy, owned by `feedService`.
  retry: 0,
  gcTime: Number.POSITIVE_INFINITY,
  refetchOnFocus: false,
  refetchOnReconnect: false,
});

/** The read's error, if the last read of `postId` failed. */
function readError(postId: string): unknown {
  const state = postSource.state(postId);
  return state.status === 'error' && state.fetchStatus === 'idle' ? state.error : undefined;
}

/**
 * Drop a post the server refused this viewer (403/404) from every surface,
 * with every held boost or quote that embeds it, transitively.
 */
function removeRevokedPost(postId: string): void {
  const revoked = new Set([postId]);
  let cohort = [postId];
  while (cohort.length > 0) {
    const references = cohort
      .flatMap((id) => Post.referencing(Post, id))
      .filter((id) => !revoked.has(id));
    for (const id of references) revoked.add(id);
    cohort = references;
  }
  for (const id of revoked) Post.remove(id);
}

const NEW_POST_ENGAGEMENT: FeedItem['engagement'] = {
  replies: 0,
  boosts: 0,
  likes: 0,
  downvotes: 0,
  saves: 0,
  views: null,
  impressions: null,
};

/** The reply count of the post answered, raised while the reply is sent. */
const sendReply = action({
  optimistic: (request: CreateReplyRequest) => {
    markLocalAction(request.postId, 'reply');
    Post.patch(request.postId, (post) => ({
      engagement: { replies: (post.engagement.replies || 0) + 1 },
    }));
  },
  run: async (request) => {
    const response = await feedService.createReply(request);
    if (!response.success || !response.reply) {
      throw new Error('Publication result could not be confirmed');
    }
    return response;
  },
});

/** The boost count of the post quoted, raised while the boost is sent. */
const sendBoost = action({
  optimistic: (request: CreateBoostRequest) =>
    Post.patch(request.originalPostId, (post) => ({
      engagement: { boosts: (post.engagement.boosts || 0) + 1 },
    })),
  run: async (request) => {
    const response = await feedService.createBoost(request);
    if (!response.success) throw new Error('Failed to create boost');
    return response;
  },
});

interface PostsStoreState {
  createPost: (request: CreatePostRequest) => Promise<{ id: string }>;
  createThread: (request: CreateThreadRequest) => Promise<FeedItem[]>;
  createReply: (request: CreateReplyRequest) => Promise<FeedItem | null>;
  createBoost: (request: CreateBoostRequest) => Promise<void>;

  boostPost: (request: { postId: string }, source?: string) => Promise<void>;
  unboostPost: (request: { postId: string }) => Promise<void>;
  likePost: (request: LikeRequest, source?: string) => Promise<void>;
  unlikePost: (request: UnlikeRequest) => Promise<void>;
  downvotePost: (request: { postId: string; type: string }) => Promise<void>;
  savePost: (request: { postId: string }, source?: string) => Promise<void>;
  unsavePost: (request: { postId: string }) => Promise<void>;

  /** The held copy, else the disk copy, else one read; joins a read in flight. */
  getPostById: (postId: string) => Promise<FeedItem | null>;
  /** Reads the post again, superseding a read in flight; drops it on 403/404. */
  revalidatePostById: (postId: string) => Promise<FeedItem | null>;
  /** Held and disk copies, then one batched read of the rest. In request order. */
  getPostsByIds: (postIds: readonly string[]) => Promise<FeedItem[]>;
  /** The chain above a post, root first: held copies, then one read for the rest. */
  loadPostAncestors: (
    postId: string,
    startParentId: string | null | undefined,
    options?: { fresh?: boolean },
  ) => Promise<FeedItem[]>;

  cachePosts: (posts: (HydratedPost | HydratedPostSummary)[]) => void;
  updatePostEverywhere: (
    postId: string,
    updater: (prev: FeedItem) => FeedItem | null | undefined,
  ) => void;
  removePostEverywhere: (postId: string) => void;
  /** Rollback of `removePostEverywhere`: back at the top of the feeds it belongs in. */
  reinsertPost: (post: FeedItem) => void;
  getPostFromDb: (postId: string) => FeedItem | null;
}

/** Waits for an action; its result is in the store, and a failure still rejects. */
const settled = async (call: Promise<unknown>): Promise<void> => {
  await call;
};

/**
 * Runs `write` in the store the call started in. An answer that lands after
 * its account was left is dropped (`undefined`), never written to the next one.
 */
function inStore<T>(store: Store, write: () => T): T | undefined {
  return store.closed ? undefined : withStore(store, write);
}

export const usePostsStore = create<PostsStoreState>()(() => ({
  createPost: async (request) => {
    const store = currentStore();
    const response = await feedService.createPost(request);
    if (!response.success || !response.post) {
      throw new Error('Publication result could not be confirmed');
    }
    const published = response.post;
    // Confirmed from here on: a local failure is logged, never reported as a
    // failed publication.
    try {
      if (published.metadata.status === 'scheduled') return { id: published.id };
      inStore(store, () => {
        const [post] = storePosts([published]);
        if (!post) return;
        Post.merge(post.id, { engagement: NEW_POST_ENGAGEMENT, isLocalNew: true });
        const stored = getPost(post.id);
        if (stored) publishNewLocalPost(stored);
        invalidateProfileCounts(queryClient, published.user?.id);
      });
    } catch (error) {
      logger.error('Post published, but the local cache update failed', error);
    }
    return { id: published.id };
  },

  createThread: async (request) => {
    const store = currentStore();
    const response = await feedService.createThread(request);
    if (
      !response.success ||
      response.posts.length !== request.posts.length ||
      !response.posts.length
    ) {
      throw new Error('Publication result could not be confirmed');
    }
    try {
      return (
        inStore(store, () => {
          const posts = storePosts(response.posts);
          for (const post of posts) {
            Post.merge(post.id, { engagement: NEW_POST_ENGAGEMENT, isLocalNew: true });
          }
          // The thread renders as one slice headed by its first post.
          const lead = getPost(posts[0]?.id);
          if (lead) publishNewLocalPost(lead);
          invalidateProfileCounts(queryClient, posts[0]?.user?.id);
          return posts.map((post) => getPost(post.id) ?? post);
        }) ?? []
      );
    } catch (error) {
      logger.error('Thread published, but the local cache update failed', error);
      return [];
    }
  },

  createReply: async (request) => {
    const store = currentStore();
    const response = await sendReply(request);
    const answer = response?.reply;
    if (!answer) return null;
    // The reply as stored, once it is: what a failure after that still returns.
    let confirmed: FeedItem | null = null;
    try {
      return (
        inStore(store, () => {
          const [reply] = storePosts([answer]);
          if (!reply) return null;
          Post.merge(reply.id, { isLocalNew: true });
          confirmed = getPost(reply.id) ?? reply;
          publishNewLocalReply(confirmed);
          return confirmed;
        }) ?? null
      );
    } catch (error) {
      logger.error('Reply published, but the local cache update failed', error);
      return confirmed;
    }
  },

  createBoost: async (request) => {
    await sendBoost(request);
  },

  boostPost: (request, from) => settled(boostPost(request.postId, from)),
  unboostPost: (request) => settled(unboostPost(request.postId)),
  likePost: (request, from) => settled(likePost(request.postId, from)),
  unlikePost: (request) => settled(unlikePost(request.postId)),
  downvotePost: (request) => settled(downvotePost(request.postId)),
  savePost: (request, from) => settled(savePost(request.postId, from)),
  unsavePost: (request) => settled(unsavePost(request.postId)),

  getPostById: async (postId) => {
    const held = getPost(postId);
    if (held) return held;
    const store = currentStore();
    await Post.load([postId]);
    const restored = inStore(store, () => getPost(postId));
    if (restored) return restored;
    await inStore(store, () => postSource.fetch(postId));
    return (
      inStore(store, () => {
        const error = readError(postId);
        if (error) throw error;
        return getPost(postId);
      }) ?? null
    );
  },

  revalidatePostById: async (postId) => {
    if (!postId) return null;
    const store = currentStore();
    await postSource.refresh(postId);
    return (
      inStore(store, () => {
        const error = readError(postId);
        if (!error) return getPost(postId);
        const { status } = normalizeApiError(error);
        if (status === 403 || status === 404) removeRevokedPost(postId);
        logger.debug('revalidatePostById failed', { postId, status });
        return null;
      }) ?? null
    );
  },

  getPostsByIds: async (postIds) => {
    const ids = [...new Set(postIds.filter(isValidPostId))];
    if (ids.length === 0) return [];
    const store = currentStore();
    await Post.load(ids.filter((id) => !Post.has(id)));
    const misses = inStore(store, () => ids.filter((id) => !Post.has(id))) ?? [];
    const chunks: string[][] = [];
    for (let offset = 0; offset < misses.length; offset += MAX_POST_BATCH) {
      chunks.push(misses.slice(offset, offset + MAX_POST_BATCH));
    }
    const pages = await Promise.all(chunks.map((chunk) => feedService.getPostsByIds(chunk)));
    return (
      inStore(store, () => {
        storePosts(pages.flat());
        return ids.flatMap((id) => {
          const post = getPost(id);
          return post ? [post] : [];
        });
      }) ?? []
    );
  },

  loadPostAncestors: async (postId, startParentId, options) => {
    const fresh = options?.fresh === true;
    if (!postId || !startParentId) return [];
    const cached = fresh ? [] : getCachedAncestorChain(postId, startParentId);
    const top = cached[0];
    // A held chain that reaches the root (or the ceiling) needs no read.
    if (top && (!top.parentPostId || cached.length >= MAX_POST_ANCESTORS)) return cached;

    const store = currentStore();
    let response: HydratedPost[];
    try {
      response = await feedService.getPostAncestors(top ? String(top.id) : postId);
    } catch (error) {
      // Unreadable, missing or offline: keep what the cache already showed.
      logger.debug('loadPostAncestors failed', { postId, ...normalizeApiError(error) });
      return store.closed ? [] : cached;
    }
    return (
      inStore(store, () => {
        const fetched = storePosts(response);
        // The chain stopped below a parent the server would not return: the
        // same answer a per-ancestor revalidation got as a 403/404.
        const stoppedAt = fetched.length > 0 ? fetched[0]?.parentPostId : startParentId;
        if (fresh && stoppedAt && fetched.length < MAX_POST_ANCESTORS) {
          removeRevokedPost(String(stoppedAt));
        }
        return [...fetched.map((post) => getPost(post.id) ?? post), ...cached].slice(
          -MAX_POST_ANCESTORS,
        );
      }) ?? []
    );
  },

  cachePosts: (posts) => {
    if (posts && posts.length > 0) storePosts(posts);
  },

  updatePostEverywhere: (postId, updater) => {
    Post.update(postId, updater);
  },

  removePostEverywhere: (postId) => {
    // A boost or quote of a removed post goes with it, as its feed rows did.
    const removed = [postId, ...Post.referencing(Post, postId)];
    for (const id of removed) Post.remove(id);
  },

  reinsertPost: (post) => {
    if (!post?.id || !isValidPostId(String(post.id))) return;
    storePosts([post]);
    publishNewLocalPost(getPost(post.id) ?? post);
  },

  getPostFromDb: (postId) => getPost(postId),
}));

/**
 * Write the server's view totals. View counting is decided entirely
 * server-side, so these are only ever numbers the server wrote. They go to the
 * view-count records alone (`PostViews`): the impression report answers for
 * every post on screen at once, and a feed row does not redraw for it.
 */
export const applyServerViewCounts = (viewCounts: FeedPostViewCounts): void => {
  const counts = Object.entries(viewCounts).flatMap(([id, views]) =>
    // Parsed JSON: a malformed payload would otherwise render as "NaN views".
    // A post never held gets no count of its own: its cell keeps the number it
    // was read with.
    isValidPostId(id) && Number.isFinite(views) && Post.has(id) ? [{ id, views }] : [],
  );
  if (counts.length > 0) PostViews.put(counts);
};

/**
 * The part of a post's ancestor chain held in memory, root first, so a cached
 * thread is on screen in the first commit. Stops at the first missing hop: a
 * chain with a hole would render parents out of order.
 */
export const getCachedAncestorChain = (
  postId: string,
  startParentId: string | undefined,
): FeedItem[] => {
  if (!postId || !startParentId) return [];
  const chain: FeedItem[] = [];
  const visited = new Set<string>([postId]);
  let nextId: string | undefined = startParentId;
  while (nextId && chain.length < MAX_POST_ANCESTORS) {
    if (visited.has(nextId)) break;
    visited.add(nextId);
    const ancestor = getPost(nextId);
    if (!ancestor) break;
    chain.push(ancestor);
    nextId = ancestor.parentPostId ? String(ancestor.parentPostId) : undefined;
  }
  return chain.reverse();
};

/** One post, with field-level subscriptions (`data/posts` `usePost`). */
export const usePostSelector = (postId: string | undefined): FeedItem | null => usePost(postId);

/** A post's view count and nothing else (`data/posts` `useViewCount`). */
export const useViewCountSelector = useViewCount;
