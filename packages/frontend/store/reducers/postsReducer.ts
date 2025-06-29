import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { fetchData, postData } from '@/utils/api';
import { Post } from '@/interfaces/Post';

// Async thunks for posts
export const fetchFeed = createAsyncThunk(
  'posts/fetchFeed',
  async (params: { 
    type?: string; 
    parentId?: string; 
    limit?: number; 
    cursor?: string | null;
  } = {}) => {
    const { type = 'all', parentId, limit = 20, cursor } = params;
    
    const endpoint = (() => {
      if (type === 'replies' && parentId) return `feed/replies/${parentId}`;
      if (type === 'media') return 'feed/media';
      if (type === 'quotes') return 'feed/quotes';
      if (type === 'reposts') return 'feed/reposts';
      if (type === 'posts') return 'feed/posts';
      if (type === 'following') return 'feed/following';
      if (type === 'home') return 'feed/home';
      if (type === 'all') return 'feed/explore';
      return 'feed/explore';
    })();

    const queryParams: any = { limit };
    if (cursor) queryParams.cursor = cursor;

    const response = await fetchData<{
      data: {
        posts: Post[];
        nextCursor: string | null;
        hasMore: boolean;
      };
    }>(endpoint, { params: queryParams });
    
    return {
      posts: response.data.posts,
      nextCursor: response.data.nextCursor,
      hasMore: response.data.hasMore,
      feedType: type,
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

interface PostsState {
  // Feed management
  posts: Record<string, Post>;
  feedPosts: {
    [feedType: string]: string[]; // Array of post IDs
  };
  nextCursor: {
    [feedType: string]: string | null;
  };
  hasMore: {
    [feedType: string]: boolean;
  };
  
  // Loading states
  isLoading: boolean;
  isRefreshing: boolean;
  isCreating: boolean;
  
  // Errors
  error: string | null;
  createError: string | null;
}

const initialState: PostsState = {
  posts: {},
  feedPosts: {},
  nextCursor: {},
  hasMore: {},
  isLoading: false,
  isRefreshing: false,
  isCreating: false,
  error: null,
  createError: null,
};

const postsSlice = createSlice({
  name: 'posts',
  initialState,
  reducers: {
    clearFeed: (state, action: PayloadAction<string>) => {
      const feedType = action.payload;
      state.feedPosts[feedType] = [];
      state.nextCursor[feedType] = null;
      state.hasMore[feedType] = true;
    },
    updatePostLocally: (state, action: PayloadAction<Partial<Post> & { id: string }>) => {
      const { id, ...updates } = action.payload;
      if (state.posts[id]) {
        state.posts[id] = { ...state.posts[id], ...updates };
      }
    },
    toggleLikeLocally: (state, action: PayloadAction<string>) => {
      const postId = action.payload;
      if (state.posts[postId]) {
        const post = state.posts[postId];
        post.isLiked = !post.isLiked;
        post.likes = post.isLiked 
          ? [...post.likes, 'user_like_id']
          : post.likes.filter(id => id !== 'user_like_id');
      }
    },
    setRefreshing: (state, action: PayloadAction<boolean>) => {
      state.isRefreshing = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      // Fetch feed
      .addCase(fetchFeed.pending, (state, action) => {
        if (action.meta.arg.cursor) {
          state.isLoading = true;
        } else {
          state.isRefreshing = true;
        }
        state.error = null;
      })
      .addCase(fetchFeed.fulfilled, (state, action) => {
        const { posts, nextCursor, hasMore, feedType, isRefresh } = action.payload;
        
                 // Add posts to the posts collection
         posts.forEach((post: Post) => {
           state.posts[post.id] = post;
         });
         
         // Update feed arrays
         if (isRefresh) {
           state.feedPosts[feedType] = posts.map((p: Post) => p.id);
         } else {
           const existing = state.feedPosts[feedType] || [];
           state.feedPosts[feedType] = [...existing, ...posts.map((p: Post) => p.id)];
         }
        
        state.nextCursor[feedType] = nextCursor;
        state.hasMore[feedType] = hasMore;
        state.isLoading = false;
        state.isRefreshing = false;
      })
      .addCase(fetchFeed.rejected, (state, action) => {
        state.isLoading = false;
        state.isRefreshing = false;
        state.error = action.error.message || 'Failed to fetch posts';
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
        Object.keys(state.feedPosts).forEach(feedType => {
          if (feedType === 'all' || feedType === 'home') {
            state.feedPosts[feedType] = [newPost.id, ...(state.feedPosts[feedType] || [])];
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
        }
      })
      
      // Unlike post  
      .addCase(unlikePost.fulfilled, (state, action) => {
        const { postId, liked } = action.payload;
        if (state.posts[postId]) {
          state.posts[postId].isLiked = liked;
        }
      })
      
      // Repost
      .addCase(repostPost.fulfilled, (state, action) => {
        const { postId, reposted } = action.payload;
        if (state.posts[postId]) {
          state.posts[postId].isReposted = reposted;
        }
      })
      
      // Bookmark
      .addCase(bookmarkPost.fulfilled, (state, action) => {
        const { postId, bookmarked } = action.payload;
        if (state.posts[postId]) {
          state.posts[postId].isBookmarked = bookmarked;
        }
      });
  },
});

export const { 
  clearFeed, 
  updatePostLocally, 
  toggleLikeLocally, 
  setRefreshing 
} = postsSlice.actions;

export default postsSlice.reducer; 