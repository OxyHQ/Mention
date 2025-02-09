import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { Post } from '@/interfaces/Post';
import { fetchData, postData, deleteData } from '@/utils/api';
import { toast } from 'sonner';
import { RootState } from '../store';

interface PostAuthor {
  id: string;
  name: { first: string; last: string };
  username: string;
  avatar?: string;
  email?: string;
  image?: string;
  description?: string;
  color?: string;
}

interface PostState {
  posts: Post[];
  bookmarkedPosts: Post[];
  loading: boolean;
  error: string | null;
}

const initialState: PostState = {
  posts: [],
  bookmarkedPosts: [],
  loading: false,
  error: null,
};

const fetchAuthor = async (authorId: string): Promise<PostAuthor | null> => {
  try {
    const authorResponse = await fetchData(`profiles/${authorId}`);
    if (authorResponse) {
      return {
        id: authorResponse.id,
        name: {
          first: authorResponse.name?.first,
          last: authorResponse.name?.last,
        },
        username: authorResponse.username,
        avatar: authorResponse.avatar || '',
      };
    }
  } catch (error) {
    console.error('Error fetching author:', error);
  }
  return null;
};

const mapPost = async (post: Post, thunkAPI: any): Promise<Post> => {
  const author = post.userID ? await fetchAuthor(post.userID) : null;
  const state = thunkAPI.getState() as RootState;
  const userId = state.session?.user?.id;
  
  let isLiked = false;
  if (userId) {
    try {
      const likeResponse = await fetchData(`posts/${post.id}/like`, { params: { userId } });
      isLiked = likeResponse.isLiked;
    } catch (error) {
      console.error('Error fetching like status:', error);
    }
  }

  return {
    ...post,
    author: author as Post['author'],
    created_at: new Date(post.created_at).toLocaleString(),
    isLiked,
    _count: {
      comments: 0,
      likes: post._count?.likes || 0,
      quotes: 0,
      reposts: 0,
      bookmarks: 0,
      replies: 0,
    },
  };
};

export const fetchPosts = createAsyncThunk(
  'posts/fetchPosts',
  async (_, { getState, rejectWithValue }) => {
    try {
      const state = getState() as RootState;
      const userId = state.session?.user?.id;
      
      if (!userId) {
        throw new Error('User not authenticated');
      }

      const response = await fetchData('posts');
      if (!response || !response.posts) {
        throw new Error('Invalid response format');
      }
      
      const posts = await Promise.all(response.posts.map((post: Post) => mapPost(post, { getState })));
      return posts;
    } catch (error: any) {
      return rejectWithValue(error.message || 'Failed to fetch posts');
    }
  }
);

export const fetchPostById = createAsyncThunk('posts/fetchPostById', async (postId: string, thunkAPI) => {
  const response = await fetchData(`posts/${postId}`);
  const post = response.posts.map((post: Post) => mapPost(post, thunkAPI));
  return Promise.all(post);
});

export const createPost = createAsyncThunk(
  'posts/createPost',
  async (newPost: Post, { rejectWithValue, getState }) => {
    try {
      const state = getState() as any;
      const userId = state.session?.user?.id;
      if (!userId) {
        throw new Error('User not authenticated');
      }
      const postWithUser = {
        ...newPost,
        userID: userId
      };
      const response = await postData('posts', postWithUser);
      return response.post;
    } catch (error: any) {
      toast(`Failed to create post: ${error.message || error.response?.data?.message}`);
      return rejectWithValue(error.response?.data || { message: error.message });
    }
  }
);

export const bookmarkPost = createAsyncThunk(
  'posts/bookmarkPost',
  async (postId: string, thunkAPI) => {
    try {
      const state = thunkAPI.getState() as any;
      const userId = state.session?.user?.id;
      if (!userId) throw new Error('User not authenticated');
      const response = await postData(`posts/${postId}/bookmark`, { userId });
      return { ...response, postId };
    } catch (error: any) {
      toast(`Failed to bookmark post: ${error.message}`);
      return thunkAPI.rejectWithValue(error.response?.data || error.message);
    }
  }
);

export const fetchBookmarkedPosts = createAsyncThunk(
  'posts/fetchBookmarkedPosts',
  async (_, thunkAPI) => {
    const state = thunkAPI.getState() as any;
    const userId = state.session?.user?.id;
    if (!userId) throw new Error('User not authenticated');
    const response = await fetchData(`posts/bookmarks`, { params: { userId } });
    const posts = response.posts.map((post: Post) => mapPost(post, thunkAPI));
    return Promise.all(posts);
  }
);

export const deleteBookmarkedPost = createAsyncThunk(
  'posts/deleteBookmarkedPost',
  async (postId: string, thunkAPI) => {
    const state = thunkAPI.getState() as any;
    const userId = state.session?.user?.id;
    if (!userId) throw new Error('User not authenticated');
    const response = await postData(`posts/${postId}/unbookmark`, { userId });
    return response;
  }
);

export const fetchPostsByHashtag = createAsyncThunk(
  'posts/fetchPostsByHashtag',
  async (hashtag: string, thunkAPI) => {
    const response = await fetchData(`posts/hashtag/${hashtag}`);
    const posts = response.posts.map((post: Post) => mapPost(post, thunkAPI));
    return Promise.all(posts);
  }
);

export const likePost = createAsyncThunk(
  'posts/likePost',
  async (postId: string, thunkAPI) => {
    try {
      const state = thunkAPI.getState() as any;
      const userId = state.session?.user?.id;
      if (!userId) throw new Error('User not authenticated');
      const response = await postData(`posts/${postId}/like`, { userId });
      return response;
    } catch (error: any) {
      toast(`Failed to like post: ${error.message}`);
      return thunkAPI.rejectWithValue(error.response?.data || error.message);
    }
  }
);

export const unlikePost = createAsyncThunk(
  'posts/unlikePost',
  async (postId: string, thunkAPI) => {
    try {
      const state = thunkAPI.getState() as any;
      const userId = state.session?.user?.id;
      if (!userId) throw new Error('User not authenticated');
      const response = await deleteData(`posts/${postId}/like`, { data: { userId } });
      return response;
    } catch (error: any) {
      toast(`Failed to unlike post: ${error.message}`);
      return thunkAPI.rejectWithValue(error.response?.data || error.message);
    }
  }
);

export const createReply = createAsyncThunk(
  'posts/createReply',
  async ({ text, postId }: { text: string, postId: string }, { rejectWithValue, getState }) => {
    try {
      const state = getState() as any;
      const userId = state.session?.user?.id;
      if (!userId) {
        throw new Error('User not authenticated');
      }
      const newPost = {
        userID: userId,
        text,
        in_reply_to_status_id: postId,
        created_at: new Date().toISOString(),
        source: 'web'
      };
      const response = await postData('posts', newPost);
      return response.post;
    } catch (error: any) {
      toast(`Failed to create reply: ${error.message || error.response?.data?.message}`);
      return rejectWithValue(error.response?.data || { message: error.message });
    }
  }
);

const postsSlice = createSlice({
  name: 'posts',
  initialState,
  reducers: {
    setPosts: (state, action: PayloadAction<Post[]>) => {
      state.posts = action.payload;
    },
    addPost: (state, action: PayloadAction<Post>) => {
      state.posts.push(action.payload);
    },
    updateLikes: (state, action: PayloadAction<string>) => {
      const postId = action.payload;
      const post = state.posts.find(post => post.id === postId);
      if (post && post._count) {
        post._count.likes += 1;
      }
    },
    updateBookmarks: (state, action: PayloadAction<string>) => {
      const postId = action.payload;
      const post = state.posts.find(post => post.id === postId);
      if (post && post._count) {
        post._count.bookmarks += 1;
      }
    },
    updatePostLikes: (state, action: PayloadAction<{ postId: string; likesCount: number; isLiked: boolean }>) => {
      const { postId, likesCount, isLiked } = action.payload;
      const post = state.posts.find(post => post.id === postId);
      if (post && post._count) {
        post._count.likes = likesCount;
        post.isLiked = isLiked;
      }
    },
    updateRepliesCount: (state, action: PayloadAction<{ postId: string; repliesCount: number }>) => {
      const { postId, repliesCount } = action.payload;
      const post = state.posts.find(post => post.id === postId);
      if (post && post._count) {
        post._count.replies = repliesCount;
      }
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchPosts.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchPosts.fulfilled, (state, action) => {
        state.loading = false;
        state.posts = action.payload;
      })
      .addCase(fetchPosts.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch posts';
      })
      .addCase(fetchPostById.fulfilled, (state, action) => {
        const fetchedPost = action.payload[0];
        const existingPostIndex = state.posts.findIndex(post => post.id === fetchedPost.id);
        if (existingPostIndex !== -1) {
          state.posts[existingPostIndex] = fetchedPost;
        } else {
          state.posts.push(fetchedPost);
        }
      })
      .addCase(createPost.pending, (state) => {
        state.loading = true;
      })
      .addCase(createPost.fulfilled, (state, action) => {
        state.loading = false;
        state.posts.push(action.payload);
      })
      .addCase(createPost.rejected, (state, action) => {
        state.loading = false;
        state.error = (action.payload as any)?.message || 'Failed to create post';
      })
      .addCase(bookmarkPost.fulfilled, (state, action) => {
        const postId = action.payload.postId;
        const post = state.posts.find(post => post.id === postId);
        if (post) {
          // Initialize _count if it doesn't exist
          if (!post._count) {
            post._count = {
              comments: 0,
              likes: 0,
              quotes: 0,
              reposts: 0,
              bookmarks: 0,
              replies: 0
            };
          }
          post._count.bookmarks += 1;
        }
      })
      .addCase(fetchBookmarkedPosts.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchBookmarkedPosts.fulfilled, (state, action) => {
        state.loading = false;
        state.bookmarkedPosts = action.payload;
      })
      .addCase(fetchBookmarkedPosts.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch bookmarked posts';
      })
      .addCase(deleteBookmarkedPost.fulfilled, (state, action) => {
        const postId = action.payload.postId;
        state.bookmarkedPosts = state.bookmarkedPosts.filter(post => post.id !== postId);
      })
      .addCase(fetchPostsByHashtag.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchPostsByHashtag.fulfilled, (state, action) => {
        state.loading = false;
        state.posts = action.payload;
      })
      .addCase(fetchPostsByHashtag.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch posts by hashtag';
      })
      .addCase(likePost.fulfilled, (state, action) => {
        const { postId, likesCount, isLiked } = action.payload;
        const post = state.posts.find(post => post.id === postId);
        if (post && post._count) {
          post._count.likes = likesCount;
          post.isLiked = isLiked;
        }
      })
      .addCase(unlikePost.fulfilled, (state, action) => {
        const { postId, likesCount, isLiked } = action.payload;
        const post = state.posts.find(post => post.id === postId);
        if (post && post._count) {
          post._count.likes = likesCount;
          post.isLiked = isLiked;
        }
      })
      .addCase(createReply.fulfilled, (state, action) => {
        state.loading = false;
        state.posts.push(action.payload);
        // Update the reply count of the parent post
        const parentPost = state.posts.find(post => post.id === action.payload.in_reply_to_status_id);
        if (parentPost && parentPost._count) {
          parentPost._count.replies += 1;
        }
      })
      .addCase(createReply.rejected, (state, action) => {
        state.loading = false;
        state.error = (action.payload as any)?.message || 'Failed to create reply';
      });
  },
});

export const { setPosts, addPost, updateLikes, updateBookmarks, updatePostLikes, updateRepliesCount } = postsSlice.actions;
export default postsSlice.reducer;
