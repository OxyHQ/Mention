import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { fetchData, postData, deleteData } from '@/utils/api';
import { toast } from 'sonner';

interface ProfileRecommendation {
  _id: string;
  userID: string;
  username?: string;
  avatar?: string;
  name?: {
    first?: string;
    last?: string;
  };
}

interface FollowState {
  loading: boolean;
  error: string | null;
  profiles: ProfileRecommendation[];
  following: Record<string, boolean>;
}

const initialState: FollowState = {
  profiles: [],
  loading: false,
  error: null,
  following: {},
};

export const followUser = createAsyncThunk(
  'follow/followUser',
  async (userId: string, { rejectWithValue }) => {
    try {
      const response = await postData(`profiles/${userId}/follow`, {});
      return { userId, ...response };
    } catch (error: any) {
      toast.error(`Failed to follow user: ${error.message}`);
      return rejectWithValue(error.response?.data || error.message);
    }
  }
);

export const unfollowUser = createAsyncThunk(
  'follow/unfollowUser',
  async (userId: string, { rejectWithValue }) => {
    try {
      const response = await deleteData(`profiles/${userId}/follow`);
      return { userId, ...response };
    } catch (error: any) {
      toast.error(`Failed to unfollow user: ${error.message}`);
      return rejectWithValue(error.response?.data || error.message);
    }
  }
);

export const checkFollowStatus = createAsyncThunk(
  'follow/checkFollowStatus',
  async (userId: string, { rejectWithValue }) => {
    try {
      const response = await fetchData(`profiles/${userId}/following-status`);
      return { userId, isFollowing: response.isFollowing };
    } catch (error: any) {
      console.error('Error checking follow status:', error);
      return rejectWithValue(error.response?.data || error.message);
    }
  }
);

export const fetchFollowRecommendations = createAsyncThunk(
  'follow/fetchRecommendations',
  async (_, { rejectWithValue }) => {
    try {
      const response = await fetchData('profiles/recommendations');
      return response as ProfileRecommendation[];
    } catch (error: any) {
      console.error('Error fetching recommendations:', error);
      return rejectWithValue(error.response?.data?.message || 'Failed to fetch recommendations');
    }
  }
);

const followSlice = createSlice({
  name: 'follow',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      // Follow User
      .addCase(followUser.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(followUser.fulfilled, (state, action) => {
        state.loading = false;
        state.following[action.payload.userId] = true;
      })
      .addCase(followUser.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to follow user';
      })
      // Unfollow User
      .addCase(unfollowUser.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(unfollowUser.fulfilled, (state, action) => {
        state.loading = false;
        state.following[action.payload.userId] = false;
      })
      .addCase(unfollowUser.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to unfollow user';
      })
      // Check Follow Status
      .addCase(checkFollowStatus.fulfilled, (state, action) => {
        state.following[action.payload.userId] = action.payload.isFollowing;
      })
      // Fetch Recommendations
      .addCase(fetchFollowRecommendations.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchFollowRecommendations.fulfilled, (state, action) => {
        state.loading = false;
        state.profiles = action.payload;
      })
      .addCase(fetchFollowRecommendations.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch follow recommendations';
      });
  },
});

export default followSlice.reducer;
