import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { Post } from '@/interfaces/Post';
import { fetchData, fetchDataOxy, sendDataOxy } from '@/utils/api';
import { toast } from 'sonner';

interface Author {
  id: string;
  name: {
    first: string;
    last: string;
  };
  username: string;
  avatar: string;
}

interface PostState {
  posts: Post[];
  loading: boolean;
  error: string | null;
}

const initialState: PostState = {
  posts: [],
  loading: false,
  error: null,
};

const fetchAuthor = async (authorId: string): Promise<Author | null> => {
  try {
    const authorResponse = await fetchDataOxy(`profiles/${authorId}`);
    if (authorResponse) {
      return {
        id: authorResponse.id,
        name: {
          first: authorResponse.name?.first,
          last: authorResponse.name?.last,
        },
        username: authorResponse.username,
        avatar: authorResponse.avatar,
      };
    }
  } catch (error) {
    console.error('Error fetching author:', error);
  }
  return null;
};

const mapPost = async (post: Post): Promise<Post> => {
  const author = post.author_id ? await fetchAuthor(post.author_id) : null;
  return {
    ...post,
    author,
    created_at: new Date(post.created_at).toLocaleString(),
    _count: {
      comments: 0,
      likes: post._count.likes,
      quotes: 0,
      reposts: 0,
      bookmarks: 0,
      replies: 0,
    },
  };
};

export const fetchPosts = createAsyncThunk('posts/fetchPosts', async () => {
  const response = await fetchDataOxy('posts');
  const posts = response.posts.map(mapPost);
  return Promise.all(posts);
});

export const fetchPostById = createAsyncThunk('posts/fetchPostById', async (postId: string) => {
  const response = await fetchData(`posts/${postId}`);
  const post = response.posts.map(mapPost);
  return Promise.all(post);
});

export const createPost = createAsyncThunk('posts/createPost', async (newPost: Post, { rejectWithValue }) => {
  try {
    const response = await sendDataOxy('posts', newPost);
    return response.post;
  } catch (error: any) {
    toast(`Failed to create post: ${error.response.data.message}`);
    return rejectWithValue(error.response.data);
  }
});

const postsSlice = createSlice({
  name: 'posts',
  initialState,
  reducers: {
    setPosts: (state, action) => {
      state.posts = action.payload;
    },
    addPost: (state, action: { payload: Post }) => {
      state.posts.push(action.payload);
    },
    updateLikes: (state, action) => {
      const postId = action.payload;
      const post = state.posts.find(post => post.id === postId);
      if (post) {
        post._count.likes += 1;
      }
    },
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
        state.error = action.payload?.message || 'Failed to create post';
      });
  },
});

export const { setPosts, addPost, updateLikes } = postsSlice.actions;
export default postsSlice.reducer;
