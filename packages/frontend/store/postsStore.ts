import { create } from 'zustand';
import api from '@/utils/api';
import { Post } from '@/interfaces/Post';

export type FeedType = 'all' | 'posts' | 'replies' | 'quotes' | 'reposts' | 'media' | 'following' | 'home' | 'custom';

interface CustomFeedOptions {
  users?: string[];
  hashtags?: string[];
  keywords?: string[];
  mediaOnly?: boolean;
}

interface FeedState {
  postIds: string[];
  nextCursor: string | null;
  hasMore: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  lastFetch: number;
}

interface PostsState {
  posts: Record<string, Post>;
  feeds: Record<string, FeedState>;
  isCreating: boolean;
  createError: string | null;
  fetchFeed: (params: {
    type?: FeedType;
    parentId?: string;
    limit?: number;
    cursor?: string | null;
    customOptions?: CustomFeedOptions;
    oxyServices?: any;
    activeSessionId?: string;
  }) => Promise<void>;
  createPost: (newPostData: { text: string; parentId?: string; media?: string[] }) => Promise<void>;
  likePost: (postId: string) => Promise<void>;
  unlikePost: (postId: string) => Promise<void>;
  repostPost: (postId: string) => Promise<void>;
  bookmarkPost: (postId: string) => Promise<void>;
  clearFeed: (feedKey: string) => void;
  updatePostLocally: (update: Partial<Post> & { id: string }) => void;
  optimisticUpdatePost: (postId: string, field: keyof Post, value: any) => void;
  setFeedRefreshing: (feedKey: string, refreshing: boolean) => void;
  resetFeeds: () => void;
}

const initialFeedState: FeedState = {
  postIds: [],
  nextCursor: null,
  hasMore: true,
  isLoading: false,
  isRefreshing: false,
  error: null,
  lastFetch: 0,
};

export const usePostsStore = create<PostsState>((set, get) => ({
  posts: {},
  feeds: {},
  isCreating: false,
  createError: null,
  fetchFeed: async (params) => {
    const { type = 'all', parentId, limit = 20, cursor, customOptions, oxyServices, activeSessionId } = params;
    const endpoint = (() => {
      if (type === 'replies' && parentId) return `/api/feed/replies/${parentId}`;
      if (type === 'custom') return '/api/feed/custom';
      if (type === 'media') return '/api/feed/media';
      if (type === 'quotes') return '/api/feed/quotes';
      if (type === 'reposts') return '/api/feed/reposts';
      if (type === 'posts') return '/api/feed/posts';
      if (type === 'following') return '/api/feed/following';
      if (type === 'home') return '/api/feed/home';
      if (type === 'all') return '/api/feed/explore';
      return '/api/feed/explore';
    })();
    const queryParams: any = { limit, mock: 'true' };
    if (cursor) queryParams.cursor = cursor;
    if (type === 'custom' && customOptions) {
      if (customOptions.users?.length) queryParams.users = customOptions.users.join(',');
      if (customOptions.hashtags?.length) queryParams.hashtags = customOptions.hashtags.join(',');
      if (customOptions.keywords?.length) queryParams.keywords = customOptions.keywords.join(',');
      if (customOptions.mediaOnly) queryParams.mediaOnly = 'true';
    }
    const feedKey = type === 'custom' && customOptions
      ? `custom_${JSON.stringify(customOptions)}`
      : parentId ? `${type}_${parentId}` : type;
    set(state => ({
      feeds: {
        ...state.feeds,
        [feedKey]: {
          ...(state.feeds[feedKey] || initialFeedState),
          isLoading: !!cursor,
          isRefreshing: !cursor,
          error: null,
        },
      },
    }));
    try {
      const response = await api.get(endpoint, {
        params: queryParams,
        oxyServices,
        activeSessionId,
      });
      const posts = response.data.data.posts;
      const nextCursor = response.data.data.nextCursor;
      const hasMore = response.data.data.hasMore;
      set(state => {
        const newPosts = { ...state.posts };
        posts.forEach((post: Post) => {
          newPosts[post.id] = post;
        });
        const feed = state.feeds[feedKey] || { ...initialFeedState };
        const isRefresh = !cursor;
        return {
          posts: newPosts,
          feeds: {
            ...state.feeds,
            [feedKey]: {
              ...feed,
              postIds: isRefresh ? posts.map((p: Post) => p.id) : [...feed.postIds, ...posts.filter((p: Post) => !feed.postIds.includes(p.id)).map((p: Post) => p.id)],
              nextCursor,
              hasMore,
              isLoading: false,
              isRefreshing: false,
              lastFetch: Date.now(),
            },
          },
        };
      });
    } catch (error: any) {
      set(() => ({
        feeds: {
          ...get().feeds,
          [feedKey]: {
            ...(get().feeds[feedKey] || initialFeedState),
            isLoading: false,
            isRefreshing: false,
            error: error?.message || 'Failed to fetch feed',
          },
        },
      }));
    }
  },
  createPost: async (newPostData) => {
    set({ isCreating: true, createError: null });
    try {
      const response = await api.post('posts', newPostData);
      set(state => ({
        isCreating: false,
        posts: { ...state.posts, [response.data.id]: response.data },
      }));
    } catch (error: any) {
      set({ isCreating: false, createError: error?.message || 'Failed to create post' });
    }
  },
  likePost: async (postId) => {
    try {
      const response = await api.post(`posts/${postId}/like`, {});
      set(state => ({
        posts: {
          ...state.posts,
          [postId]: { ...state.posts[postId], isLiked: response.data.liked },
        },
      }));
    } catch {}
  },
  unlikePost: async (postId) => {
    try {
      const response = await api.post(`posts/${postId}/unlike`, {});
      set(state => ({
        posts: {
          ...state.posts,
          [postId]: { ...state.posts[postId], isLiked: !response.data.liked },
        },
      }));
    } catch {}
  },
  repostPost: async (postId) => {
    try {
      const response = await api.post(`posts/${postId}/repost`, {});
      set(state => ({
        posts: {
          ...state.posts,
          [postId]: { ...state.posts[postId], isReposted: response.data.reposted },
        },
      }));
    } catch {}
  },
  bookmarkPost: async (postId) => {
    try {
      const response = await api.post(`posts/${postId}/bookmark`, {});
      set(state => ({
        posts: {
          ...state.posts,
          [postId]: { ...state.posts[postId], isBookmarked: response.data.bookmarked },
        },
      }));
    } catch {}
  },
  clearFeed: (feedKey) => {
    set(state => ({
      feeds: {
        ...state.feeds,
        [feedKey]: { ...initialFeedState },
      },
    }));
  },
  updatePostLocally: (update) => {
    set(state => ({
      posts: {
        ...state.posts,
        [update.id]: { ...state.posts[update.id], ...update },
      },
    }));
  },
  optimisticUpdatePost: (postId, field, value) => {
    set(state => ({
      posts: {
        ...state.posts,
        [postId]: { ...state.posts[postId], [field]: value },
      },
    }));
  },
  setFeedRefreshing: (feedKey, refreshing) => {
    set(state => ({
      feeds: {
        ...state.feeds,
        [feedKey]: {
          ...(state.feeds[feedKey] || initialFeedState),
          isRefreshing: refreshing,
        },
      },
    }));
  },
  resetFeeds: () => {
    set({ feeds: {}, posts: {} });
  },
})); 