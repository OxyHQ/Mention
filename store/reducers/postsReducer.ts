import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { Post } from '@/interfaces/Post';
import { fetchData, fetchDataOxy, sendData, sendDataOxy } from '@/utils/api';
import { toast } from 'sonner';

const initialState: { posts: Post[], loading: boolean, error: string | null } = {
  posts: [],
  loading: false,
  error: null,
};

export const fetchPosts = createAsyncThunk('posts/', async () => {
  const response = await fetchDataOxy("posts");
  const posts = response.posts.map((post: Post) => ({
        id: post.id,
        text: post.text,
        source: post.source,
        in_reply_to_user_id: post.in_reply_to_user_id,
        in_reply_to_username: post.in_reply_to_username,
        is_quote_status: post.is_quote_status,
        quoted_status_id: post.quoted_status_id,
        favorite_count: post.favorite_count,
        possibly_sensitive: post.possibly_sensitive,
        lang: post.lang,
        created_at: new Date(post.created_at).toLocaleString(),
        quoted_post_id: post.quoted_post_id,
        in_reply_to_status_id: post.in_reply_to_status_id,
        author_id: post.author_id,
        author: {
          ...post.author,
          image: "https://scontent-bcn1-1.xx.fbcdn.net/v/t39.30808-6/463417298_3945442859019280_8807009322776007473_n.jpg?_nc_cat=111&ccb=1-7&_nc_sid=6ee11a&_nc_ohc=zXRqATKNOw0Q7kNvgHnyfUU&_nc_oc=AdgYVSd5vfuRV96_nxCmCnemTuCfkgS2YQ_Diu1puFc_h76AbObPG9_eD5rFA5TcRxYnE2mW_ZfJKWuXYtX-Z8ue&_nc_zt=23&_nc_ht=scontent-bcn1-1.xx&_nc_gid=AqvR1nQbgt2nJudR3eAKaLM&oh=00_AYBD3grUDwAE84jgvGS3UmB93xn3odRDqePjARpVj6L2vQ&oe=678C0857",
        },
        media: post.media,
        quoted_post: post.quoted_post,
        quotes: post.quotes,
        _count: {
          comments: 0,
          likes: post._count.likes,
          quotes: 0,
          reposts: 0,
          bookmarks: 0,
          replies: 0,
        },
      }));
  return posts;
});

export const fetchPostById = createAsyncThunk(
  'posts/fetchPostById',
  async (postId: string) => {
    const response = await fetchData(`posts/${postId}`);
    const post = response.posts.map((post: Post) => ({
        id: post.id,
        text: post.text,
        source: post.source,
        in_reply_to_user_id: post.in_reply_to_user_id,
        in_reply_to_username: post.in_reply_to_username,
        is_quote_status: post.is_quote_status,
        quoted_status_id: post.quoted_status_id,
        favorite_count: post.favorite_count,
        possibly_sensitive: post.possibly_sensitive,
        lang: post.lang,
        created_at: new Date(post.created_at).toLocaleString(),
        quoted_post_id: post.quoted_post_id,
        in_reply_to_status_id: post.in_reply_to_status_id,
        author_id: post.author_id,
        author: {
          ...post.author,
          image: "https://scontent-bcn1-1.xx.fbcdn.net/v/t39.30808-6/463417298_3945442859019280_8807009322776007473_n.jpg?_nc_cat=111&ccb=1-7&_nc_sid=6ee11a&_nc_ohc=zXRqATKNOw0Q7kNvgHnyfUU&_nc_oc=AdgYVSd5vfuRV96_nxCmCnemTuCfkgS2YQ_Diu1puFc_h76AbObPG9_eD5rFA5TcRxYnE2mW_ZfJKWuXYtX-Z8ue&_nc_zt=23&_nc_ht=scontent-bcn1-1.xx&_nc_gid=AqvR1nQbgt2nJudR3eAKaLM&oh=00_AYBD3grUDwAE84jgvGS3UmB93xn3odRDqePjARpVj6L2vQ&oe=678C0857",
        },
        media: post.media,
        quoted_post: post.quoted_post,
        quotes: post.quotes,
        _count: {
          comments: 0,
          likes: post._count.likes,
          quotes: 0,
          reposts: 0,
          bookmarks: 0,
          replies: 0,
        },
      }));
      return post;
  }
);

export const createPost = createAsyncThunk(
  'posts/createPost',
  async (newPost: Post, { rejectWithValue }) => {
    try {
      const response = await sendDataOxy('posts', newPost);
      return response.post;
    } catch (error: any) {
      return rejectWithValue(error.response.data);
    }
  }
);

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
        toast(`Failed to create post: ${action.payload?.error?.message}`);
      });
  },
});

export const { setPosts, addPost, updateLikes } = postsSlice.actions;
export default postsSlice.reducer;
