import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { fetchData, postData } from '@/utils/api';

// Define profile interface (linked to Oxy user)
interface Profile {
  id: string;
  oxyUserId: string; // Links to the Oxy authenticated user
  username: string;
  displayName?: string;
  bio?: string;
  avatar?: string;
  coverImage?: string;
  location?: string;
  website?: string;
  followers?: number;
  following?: number;
  postsCount?: number;
  verified?: boolean;
  createdAt: string;
  updatedAt: string;
}

// Async thunk for fetching profile by Oxy user ID
export const fetchProfile = createAsyncThunk(
  'profile/fetchProfile',
  async (oxyUserId: string) => {
    const response = await fetchData(`profiles/${oxyUserId}`);
    return response as Profile;
  }
);

// Async thunk for fetching profile by username
export const fetchProfileByUsername = createAsyncThunk(
  'profile/fetchProfileByUsername',
  async (username: string) => {
    const response = await fetchData(`profiles/username/${username}`);
    return response as Profile;
  }
);

// Async thunk for creating/updating profile
export const updateProfile = createAsyncThunk(
  'profile/updateProfile',
  async (updates: Partial<Profile>) => {
    const response = await postData('profiles', updates);
    return response as Profile;
  }
);

// Async thunk for following a user
export const followUser = createAsyncThunk(
  'profile/followUser',
  async (targetOxyUserId: string) => {
    const response = await postData(`profiles/${targetOxyUserId}/follow`, {});
    return response;
  }
);

// Async thunk for unfollowing a user
export const unfollowUser = createAsyncThunk(
  'profile/unfollowUser',
  async (targetOxyUserId: string) => {
    const response = await postData(`profiles/${targetOxyUserId}/unfollow`, {});
    return response;
  }
);

interface ProfileState {
  // Current user's profile (linked to Oxy authenticated user)
  currentProfile: Profile | null;
  
  // Viewing profile (when looking at other users)
  viewingProfile: Profile | null;
  
  // Cached profiles by Oxy user ID
  profiles: Record<string, Profile>;
  
  // Loading states
  isLoading: boolean;
  profileLoading: boolean;
  followLoading: boolean;
  
  // Error states
  error: string | null;
  followError: string | null;
}

const initialState: ProfileState = {
  currentProfile: null,
  viewingProfile: null,
  profiles: {},
  isLoading: false,
  profileLoading: false,
  followLoading: false,
  error: null,
  followError: null,
};

const profileSlice = createSlice({
  name: 'profile',
  initialState,
  reducers: {
    setCurrentProfile: (state, action: PayloadAction<Profile>) => {
      state.currentProfile = action.payload;
      state.profiles[action.payload.oxyUserId] = action.payload;
      state.error = null;
    },
    clearCurrentProfile: (state) => {
      state.currentProfile = null;
      state.error = null;
    },
    setViewingProfile: (state, action: PayloadAction<Profile | null>) => {
      state.viewingProfile = action.payload;
    },
    updateProfileLocally: (state, action: PayloadAction<Partial<Profile> & { oxyUserId: string }>) => {
      const { oxyUserId, ...updates } = action.payload;
      if (state.profiles[oxyUserId]) {
        state.profiles[oxyUserId] = { ...state.profiles[oxyUserId], ...updates };
      }
      if (state.currentProfile?.oxyUserId === oxyUserId) {
        state.currentProfile = { ...state.currentProfile, ...updates };
      }
      if (state.viewingProfile?.oxyUserId === oxyUserId) {
        state.viewingProfile = { ...state.viewingProfile, ...updates };
      }
    },
    setProfileError: (state, action: PayloadAction<string>) => {
      state.error = action.payload;
      state.isLoading = false;
    },
  },
  extraReducers: (builder) => {
    builder
      // Fetch profile
      .addCase(fetchProfile.pending, (state) => {
        state.profileLoading = true;
        state.error = null;
      })
      .addCase(fetchProfile.fulfilled, (state, action) => {
        state.profileLoading = false;
        const profile = action.payload;
        state.profiles[profile.oxyUserId] = profile;
        // If this is the current user's profile, set it
        if (state.currentProfile?.oxyUserId === profile.oxyUserId) {
          state.currentProfile = profile;
        }
      })
      .addCase(fetchProfile.rejected, (state, action) => {
        state.profileLoading = false;
        state.error = action.error.message || 'Failed to fetch profile';
      })
      
      // Fetch profile by username
      .addCase(fetchProfileByUsername.pending, (state) => {
        state.profileLoading = true;
        state.error = null;
      })
      .addCase(fetchProfileByUsername.fulfilled, (state, action) => {
        state.profileLoading = false;
        const profile = action.payload;
        state.profiles[profile.oxyUserId] = profile;
        state.viewingProfile = profile;
      })
      .addCase(fetchProfileByUsername.rejected, (state, action) => {
        state.profileLoading = false;
        state.error = action.error.message || 'Failed to fetch profile';
      })
      
      // Update profile
      .addCase(updateProfile.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(updateProfile.fulfilled, (state, action) => {
        state.isLoading = false;
        const profile = action.payload;
        state.profiles[profile.oxyUserId] = profile;
        if (state.currentProfile?.oxyUserId === profile.oxyUserId) {
          state.currentProfile = profile;
        }
      })
      .addCase(updateProfile.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to update profile';
      })
      
      // Follow user
      .addCase(followUser.pending, (state) => {
        state.followLoading = true;
        state.followError = null;
      })
      .addCase(followUser.fulfilled, (state, action) => {
        state.followLoading = false;
        // Update follower counts locally if needed
      })
      .addCase(followUser.rejected, (state, action) => {
        state.followLoading = false;
        state.followError = action.error.message || 'Failed to follow user';
      })
      
      // Unfollow user
      .addCase(unfollowUser.pending, (state) => {
        state.followLoading = true;
        state.followError = null;
      })
      .addCase(unfollowUser.fulfilled, (state, action) => {
        state.followLoading = false;
        // Update follower counts locally if needed
      })
      .addCase(unfollowUser.rejected, (state, action) => {
        state.followLoading = false;
        state.followError = action.error.message || 'Failed to unfollow user';
      });
  },
});

export const { 
  setCurrentProfile, 
  clearCurrentProfile, 
  setViewingProfile,
  updateProfileLocally,
  setProfileError 
} = profileSlice.actions;

export default profileSlice.reducer; 