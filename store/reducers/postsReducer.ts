import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { Post } from '@/interfaces/Post';
import { fetchData } from '@/utils/api';

const initialState: { posts: Post[], loading: boolean, error: string | null } = {
  posts: [],
  loading: false,
  error: null,
};

export const fetchPosts = createAsyncThunk('posts/', async () => {
  const response = await fetchData("posts");
  const posts = response.posts.map((post: Post) => ({
        id: post.id,
        text: decodeURIComponent(post.text),
        source: post.source,
        in_reply_to_user_id: post.in_reply_to_user_id,
        in_reply_to_username: post.in_reply_to_username,
        is_quote_status: post.is_quote_status,
        quoted_status_id: post.quoted_status_id,
        quote_count: post.quote_count,
        reply_count: post.reply_count,
        repost_count: post.repost_count,
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
        likes: post.likes,
        media: post.media,
        quoted_post: post.quoted_post,
        quotes: post.quotes,
        comments: 0,
        bookmarks: 0,
        _count: {
          comments: 0,
          likes: 0,
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
        text: decodeURIComponent(post.text),
        source: post.source,
        in_reply_to_user_id: post.in_reply_to_user_id,
        in_reply_to_username: post.in_reply_to_username,
        is_quote_status: post.is_quote_status,
        quoted_status_id: post.quoted_status_id,
        quote_count: post.quote_count,
        reply_count: post.reply_count,
        repost_count: post.repost_count,
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
        likes: post.likes,
        media: post.media,
        quoted_post: post.quoted_post,
        quotes: post.quotes,
        comments: 0,
        bookmarks: 0,
        _count: {
          comments: 0,
          likes: 0,
          quotes: 0,
          reposts: 0,
          bookmarks: 0,
          replies: 0,
        },
    }));
      return post;
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
      });
  },
});

export const { setPosts, addPost } = postsSlice.actions;
export default postsSlice.reducer;
