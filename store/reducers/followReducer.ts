import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { toast } from 'sonner';
import { profileService } from '@/modules/oxyhqservices';
import { fetchData } from '@/modules/oxyhqservices/utils/api';
import type { OxyProfile } from '@/modules/oxyhqservices/types';

interface ProfileRecommendation extends Partial<OxyProfile> {
  userID: string;
}

interface FollowState {
  loading: {
    follow: boolean;
    recommendations: boolean;
    status: boolean;
  };
  error: string | null;
  profiles: ProfileRecommendation[];
  following: Record<string, boolean>;
  followingIds: string[];
}

const initialState: FollowState = {
  profiles: [],
  loading: {
    follow: false,
    recommendations: false,
    status: false
  },
  error: null,
  following: {},
  followingIds: []
};

export const followUser = createAsyncThunk(
  'follow/followUser',
  async (userId: string, { rejectWithValue }) => {
    try {
      const response = await profileService.follow(userId);
      return { 
        userId, 
        action: response.action,
        counts: response.counts
      };
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Failed to follow user';
      toast.error(errorMessage);
      return rejectWithValue(errorMessage);
    }
  }
);

export const unfollowUser = createAsyncThunk(
  'follow/unfollowUser',
  async (userId: string, { rejectWithValue }) => {
    try {
      await profileService.unfollow(userId);
      return { userId, success: true };
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Failed to unfollow user';
      toast.error(errorMessage);
      return rejectWithValue(errorMessage);
    }
  }
);

export const checkFollowStatus = createAsyncThunk(
  'follow/checkFollowStatus',
  async (userId: string, { rejectWithValue }) => {
    try {
      const isFollowing = await profileService.getFollowingStatus(userId);
      return { userId, isFollowing };
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Failed to check follow status';
      console.error('Error checking follow status:', errorMessage);
      return rejectWithValue(errorMessage);
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
  reducers: {
    setFollowing: (state, action: PayloadAction<string[]>) => {
      state.followingIds = action.payload;
      action.payload.forEach(id => {
        state.following[id] = true;
      });
    },
    addFollowing: (state, action: PayloadAction<string>) => {
      if (!state.followingIds.includes(action.payload)) {
        state.followingIds.push(action.payload);
        state.following[action.payload] = true;
      }
    },
    removeFollowing: (state, action: PayloadAction<string>) => {
      state.followingIds = state.followingIds.filter(id => id !== action.payload);
      state.following[action.payload] = false;
    }
  },
  extraReducers: (builder) => {
    builder
      // Follow User
      .addCase(followUser.pending, (state) => {
        state.loading.follow = true;
        state.error = null;
      })
      .addCase(followUser.fulfilled, (state, action) => {
        state.loading.follow = false;
        state.error = null;
        
        // Update following state based on action
        const { userId, action: followAction } = action.payload;
        const isFollowing = followAction === 'follow';
        
        // Update following state
        state.following[userId] = isFollowing;
        
        // Update followingIds array
        const isInArray = state.followingIds.includes(userId);
        if (isFollowing && !isInArray) {
          state.followingIds.push(userId);
        } else if (!isFollowing && isInArray) {
          state.followingIds = state.followingIds.filter(id => id !== userId);
        }

        // Update profile counts if available
        if (action.payload.counts) {
          const profile = state.profiles.find(p => p._id === userId || p.userID === userId);
          if (profile && profile._count) {
            profile._count.followers = action.payload.counts.followers;
          }
        }
      })
      .addCase(followUser.rejected, (state, action) => {
        state.loading.follow = false;
        state.error = action.error.message || 'Failed to follow user';
      })
      // Unfollow User
      .addCase(unfollowUser.pending, (state) => {
        state.loading.follow = true;
        state.error = null;
      })
      .addCase(unfollowUser.fulfilled, (state, action) => {
        state.loading.follow = false;
        state.following[action.payload.userId] = false;
        state.followingIds = state.followingIds.filter(id => id !== action.payload.userId);
      })
      .addCase(unfollowUser.rejected, (state, action) => {
        state.loading.follow = false;
        state.error = action.error.message || 'Failed to unfollow user';
      })
      // Check Follow Status
      .addCase(checkFollowStatus.pending, (state) => {
        state.loading.status = true;
        state.error = null;
      })
      .addCase(checkFollowStatus.fulfilled, (state, action) => {
        state.loading.status = false;
        state.error = null;
        const { userId, isFollowing } = action.payload;
        
        // Update following state
        state.following[userId] = isFollowing;
        
        // Update followingIds array
        const isInArray = state.followingIds.includes(userId);
        if (isFollowing && !isInArray) {
          state.followingIds.push(userId);
        } else if (!isFollowing && isInArray) {
          state.followingIds = state.followingIds.filter(id => id !== userId);
        }
      })
      .addCase(checkFollowStatus.rejected, (state, action) => {
        state.loading.status = false;
        state.error = action.error.message || 'Failed to check follow status';
      })
      // Fetch Recommendations
      .addCase(fetchFollowRecommendations.pending, (state) => {
        state.loading.recommendations = true;
        state.error = null;
      })
      .addCase(fetchFollowRecommendations.fulfilled, (state, action) => {
        state.loading.recommendations = false;
        state.profiles = action.payload;
      })
      .addCase(fetchFollowRecommendations.rejected, (state, action) => {
        state.loading.recommendations = false;
        state.error = action.error.message || 'Failed to fetch follow recommendations';
      });
  },
});

export const { setFollowing, addFollowing, removeFollowing } = followSlice.actions;
export default followSlice.reducer;
