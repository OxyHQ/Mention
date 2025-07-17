import { createSlice, createAsyncThunk, PayloadAction, createSelector } from '@reduxjs/toolkit';
import api, { postData } from '@/utils/api';
import { Post } from '@/interfaces/Post';

export type FeedType = 'all' | 'posts' | 'replies' | 'quotes' | 'reposts' | 'media' | 'following' | 'home' | 'custom';

interface CustomFeedOptions {
  users?: string[];
  hashtags?: string[];
  keywords?: string[];
  mediaOnly?: boolean;
}

interface FetchFeedParams {
  type?: FeedType;
  parentId?: string;
  limit?: number;
  cursor?: string | null;
  customOptions?: CustomFeedOptions;
}

// Async thunks for posts
export const fetchFeed = createAsyncThunk(
  'posts/fetchFeed',
  async (params: FetchFeedParams = {}) => {
    const { type = 'all', parentId, limit = 20, cursor, customOptions } = params;
    
    const endpoint = (() => {
      if (type === 'replies' && parentId) return `feed/replies/${parentId}`;
      if (type === 'custom') return 'feed/custom';
      if (type === 'media') return 'feed/media';
      if (type === 'quotes') return 'feed/quotes';
      if (type === 'reposts') return 'feed/reposts';
      if (type === 'posts') return 'feed/posts';
      if (type === 'following') return 'feed/following';
      if (type === 'home') return 'feed/home';
      if (type === 'all') return 'feed/explore';
      return 'feed/explore';
    })();

    const queryParams: any = { limit, mock: 'true' };
    if (cursor) queryParams.cursor = cursor;
    
    // Add custom feed parameters
    if (type === 'custom' && customOptions) {
      if (customOptions.users?.length) queryParams.users = customOptions.users.join(',');
      if (customOptions.hashtags?.length) queryParams.hashtags = customOptions.hashtags.join(',');
      if (customOptions.keywords?.length) queryParams.keywords = customOptions.keywords.join(',');
      if (customOptions.mediaOnly) queryParams.mediaOnly = 'true';
    }

    const response = await api.get(endpoint, { params: queryParams });
    
    // Create unique feed key for different feed configurations
    const feedKey = type === 'custom' && customOptions
      ? `custom_${JSON.stringify(customOptions)}`
      : parentId ? `${type}_${parentId}` : type;
    
    return {
      posts: response.data.data.posts,
      nextCursor: response.data.data.nextCursor,
      hasMore: response.data.data.hasMore,
      feedKey,
      isRefresh: !cursor
    };
  }
);

export const createPost = createAsyncThunk(
  'posts/createPost',
  async (newPostData: {
    text: string;
    parentId?: string;
    media?: string[];
  }) => {
    const response = await postData('posts', newPostData);
    return response as Post;
  }
);

export const likePost = createAsyncThunk(
  'posts/likePost',
  async (postId: string) => {
    const response = await postData(`posts/${postId}/like`, {});
    return { postId, liked: response.liked };
  }
);

export const unlikePost = createAsyncThunk(
  'posts/unlikePost',
  async (postId: string) => {
    const response = await postData(`posts/${postId}/unlike`, {});
    return { postId, liked: response.liked };
  }
);

export const repostPost = createAsyncThunk(
  'posts/repost',
  async (postId: string) => {
    const response = await postData(`posts/${postId}/repost`, {});
    return { postId, reposted: response.reposted };
  }
);

export const bookmarkPost = createAsyncThunk(
  'posts/bookmark',
  async (postId: string) => {
    const response = await postData(`posts/${postId}/bookmark`, {});
    return { postId, bookmarked: response.bookmarked };
  }
);

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
  // Normalized posts storage
  posts: Record<string, Post>;
  
  // Feed management - each feed has its own state
  feeds: Record<string, FeedState>;
  
  // Global states
  isCreating: boolean;
  createError: string | null;
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

const initialState: PostsState = {
  posts: {},
  feeds: {},
  isCreating: false,
  createError: null,
};

const postsSlice = createSlice({
  name: 'posts',
  initialState,
  reducers: {
    clearFeed: (state, action: PayloadAction<string>) => {
      const feedKey = action.payload;
      if (state.feeds[feedKey]) {
        state.feeds[feedKey] = { ...initialFeedState };
      }
    },
    updatePostLocally: (state, action: PayloadAction<Partial<Post> & { id: string }>) => {
      const { id, ...updates } = action.payload;
      if (state.posts[id]) {
        state.posts[id] = { ...state.posts[id], ...updates };
      }
    },
    optimisticUpdatePost: (state, action: PayloadAction<{ postId: string; field: keyof Post; value: any }>) => {
      const { postId, field, value } = action.payload;
      if (state.posts[postId]) {
        (state.posts[postId] as any)[field] = value;
      }
    },
    setFeedRefreshing: (state, action: PayloadAction<{ feedKey: string; refreshing: boolean }>) => {
      const { feedKey, refreshing } = action.payload;
      if (!state.feeds[feedKey]) {
        state.feeds[feedKey] = { ...initialFeedState };
      }
      state.feeds[feedKey].isRefreshing = refreshing;
    },
    // Reset all feeds (useful for logout/login)
    resetFeeds: (state) => {
      state.feeds = {};
      state.posts = {};
    },
  },
  extraReducers: (builder) => {
    builder
      // Fetch feed
      .addCase(fetchFeed.pending, (state, action) => {
        const { cursor } = action.meta.arg;
        const feedKey = action.meta.arg.type === 'custom' && action.meta.arg.customOptions
          ? `custom_${JSON.stringify(action.meta.arg.customOptions)}`
          : action.meta.arg.parentId 
            ? `${action.meta.arg.type || 'all'}_${action.meta.arg.parentId}` 
            : action.meta.arg.type || 'all';
        
        if (!state.feeds[feedKey]) {
          state.feeds[feedKey] = { ...initialFeedState };
        }
        
        if (cursor) {
          state.feeds[feedKey].isLoading = true;
        } else {
          state.feeds[feedKey].isRefreshing = true;
        }
        state.feeds[feedKey].error = null;
      })
      .addCase(fetchFeed.fulfilled, (state, action) => {
        const { posts, nextCursor, hasMore, feedKey, isRefresh } = action.payload;
        
        if (!state.feeds[feedKey]) {
          state.feeds[feedKey] = { ...initialFeedState };
        }
        
        // Add posts to the normalized posts collection
        posts.forEach((post: Post) => {
          state.posts[post.id] = post;
        });
        
        // Update feed state
        const feed = state.feeds[feedKey];
        if (isRefresh) {
          feed.postIds = posts.map((p: Post) => p.id);
        } else {
          // Remove duplicates when appending
          const existingIds = new Set(feed.postIds);
          const newIds = posts.filter((p: Post) => !existingIds.has(p.id)).map((p: Post) => p.id);
          feed.postIds = [...feed.postIds, ...newIds];
        }
        
        feed.nextCursor = nextCursor;
        feed.hasMore = hasMore;
        feed.isLoading = false;
        feed.isRefreshing = false;
        feed.lastFetch = Date.now();
      })
      .addCase(fetchFeed.rejected, (state, action) => {
        const feedKey = action.meta.arg.type === 'custom' && action.meta.arg.customOptions
          ? `custom_${JSON.stringify(action.meta.arg.customOptions)}`
          : action.meta.arg.parentId 
            ? `${action.meta.arg.type || 'all'}_${action.meta.arg.parentId}` 
            : action.meta.arg.type || 'all';
        
        if (!state.feeds[feedKey]) {
          state.feeds[feedKey] = { ...initialFeedState };
        }
        
        state.feeds[feedKey].isLoading = false;
        state.feeds[feedKey].isRefreshing = false;
        state.feeds[feedKey].error = action.error.message || 'Failed to fetch posts';
      })
      
      // Create post
      .addCase(createPost.pending, (state) => {
        state.isCreating = true;
        state.createError = null;
      })
      .addCase(createPost.fulfilled, (state, action) => {
        state.isCreating = false;
        const newPost = action.payload;
        state.posts[newPost.id] = newPost;
        
        // Add to the beginning of relevant feeds
        Object.keys(state.feeds).forEach(feedKey => {
          if (feedKey === 'all' || feedKey === 'home' || feedKey === 'following') {
            state.feeds[feedKey].postIds = [newPost.id, ...state.feeds[feedKey].postIds];
          }
        });
      })
      .addCase(createPost.rejected, (state, action) => {
        state.isCreating = false;
        state.createError = action.error.message || 'Failed to create post';
      })
      
      // Like post
      .addCase(likePost.fulfilled, (state, action) => {
        const { postId, liked } = action.payload;
        if (state.posts[postId]) {
          state.posts[postId].isLiked = liked;
          // Update like count if available
          if (state.posts[postId]._count?.likes !== undefined) {
            const currentCount = state.posts[postId]._count!.likes || 0;
            state.posts[postId]._count!.likes = liked ? currentCount + 1 : Math.max(0, currentCount - 1);
          }
        }
      })
      
      // Unlike post  
      .addCase(unlikePost.fulfilled, (state, action) => {
        const { postId, liked } = action.payload;
        if (state.posts[postId]) {
          state.posts[postId].isLiked = liked;
          if (state.posts[postId]._count?.likes !== undefined) {
            const currentCount = state.posts[postId]._count!.likes || 0;
            state.posts[postId]._count!.likes = liked ? currentCount + 1 : Math.max(0, currentCount - 1);
          }
        }
      })
      
      // Repost
      .addCase(repostPost.fulfilled, (state, action) => {
        const { postId, reposted } = action.payload;
        if (state.posts[postId]) {
          state.posts[postId].isReposted = reposted;
          if (state.posts[postId]._count?.reposts !== undefined) {
            const currentCount = state.posts[postId]._count!.reposts || 0;
            state.posts[postId]._count!.reposts = reposted ? currentCount + 1 : Math.max(0, currentCount - 1);
          }
        }
      })
      
      // Bookmark
      .addCase(bookmarkPost.fulfilled, (state, action) => {
        const { postId, bookmarked } = action.payload;
        if (state.posts[postId]) {
          state.posts[postId].isBookmarked = bookmarked;
          if (state.posts[postId]._count?.bookmarks !== undefined) {
            const currentCount = state.posts[postId]._count!.bookmarks || 0;
            state.posts[postId]._count!.bookmarks = bookmarked ? currentCount + 1 : Math.max(0, currentCount - 1);
          }
        }
      });
  },
});

// Selectors
export const selectPosts = (state: { posts: PostsState }) => state.posts.posts;
export const selectFeed = (feedKey: string) => (state: { posts: PostsState }) => state.posts.feeds[feedKey] || initialFeedState;

export const selectFeedPosts = createSelector(
  [selectPosts, (state: { posts: PostsState }, feedKey: string) => selectFeed(feedKey)(state)],
  (posts, feed) => {
    return feed.postIds.map(id => posts[id]).filter(Boolean);
  }
);

export const selectFeedWithPosts = (feedKey: string) => createSelector(
  [selectPosts, selectFeed(feedKey)],
  (posts, feed) => ({
    ...feed,
    posts: feed.postIds.map(id => posts[id]).filter(Boolean),
  })
);

export const { 
  clearFeed, 
  updatePostLocally, 
  optimisticUpdatePost,
  setFeedRefreshing,
  resetFeeds,
} = postsSlice.actions;

export default postsSlice.reducer; 
