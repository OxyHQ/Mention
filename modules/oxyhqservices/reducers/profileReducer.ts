/**
 * Profile Reducer
 * 
 * Redux slice for managing user profile state and operations.
 * Provides async thunks for fetching and updating profile data.
 */

import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { OxyProfile } from '../types';
import { apiService } from '../services/api.service';
import { ENDPOINTS, ERROR_MESSAGES } from '../constants';

/**
 * Profile state interface
 */
interface ProfileState {
  profile: OxyProfile | null;
  loading: boolean;
  error: string | null;
}

/**
 * Initial state for profile slice
 */
const initialState: ProfileState = {
  profile: null,
  loading: false,
  error: null,
};

/**
 * Response type for username lookup
 */
interface UsernameResponse {
  _id?: string;
  [key: string]: any;
}

/**
 * Helper function to get a user ID from username
 */
export const getUsernameToId = async ({ username }: { username: string }): Promise<string | null> => {
  try {
    const response = await apiService.get<UsernameResponse>(`/profiles/username/${username}`);
    return response.data?._id || null;
  } catch (error) {
    console.error('Error in getUsernameToId:', error);
    return null;
  }
};

/**
 * Async thunk to fetch a user profile by username
 */
export const fetchProfile = createAsyncThunk(
  'profile/fetchProfile', 
  async ({ username }: { username: string }, { rejectWithValue }) => {
    try {
      const userId = await getUsernameToId({ username });
      
      if (!userId || typeof userId !== 'string') {
        return rejectWithValue(`User not found: ${username}`);
      }
      
      const response = await apiService.get<OxyProfile>(ENDPOINTS.USERS.PROFILE(userId));
      
      if (!response.data) {
        return rejectWithValue('No profile data received');
      }
      
      return response.data;
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || ERROR_MESSAGES.DEFAULT;
      return rejectWithValue(errorMessage);
    }
  }
);

/**
 * Async thunk to update a user profile
 */
export const updateProfileData = createAsyncThunk(
  'profile/updateProfileData',
  async (
    { id, data }: { id: string; data: Partial<OxyProfile> }, 
    { rejectWithValue }
  ) => {
    try {
      const response = await apiService.patch<OxyProfile>(
        ENDPOINTS.USERS.PROFILE(id),
        data
      );
      return response.data;
    } catch (error: any) {
      return rejectWithValue(
        error.response?.data?.message || ERROR_MESSAGES.DEFAULT
      );
    }
  }
);

/**
 * Profile redux slice with reducers and actions
 */
const profileSlice = createSlice({
  name: 'profile',
  initialState,
  reducers: {
    /**
     * Set profile data manually
     */
    setProfile: (state, action: PayloadAction<OxyProfile>) => {
      state.profile = action.payload;
      state.loading = false;
      state.error = null;
    },
    
    /**
     * Clear profile data
     */
    clearProfile: (state) => {
      state.profile = null;
      state.loading = false;
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // Fetch profile cases
      .addCase(fetchProfile.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchProfile.fulfilled, (state, action) => {
        state.loading = false;
        state.profile = action.payload;
      })
      .addCase(fetchProfile.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload as string || action.error.message || ERROR_MESSAGES.DEFAULT;
      })
      
      // Update profile cases
      .addCase(updateProfileData.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(updateProfileData.fulfilled, (state, action) => {
        state.loading = false;
        state.profile = action.payload;
      })
      .addCase(updateProfileData.rejected, (state, action) => {
        state.loading = false;
        state.error = (action.payload as string) || action.error.message || ERROR_MESSAGES.DEFAULT;
      });
  },
});

// Export actions and reducer
export const { setProfile, clearProfile } = profileSlice.actions;
export default profileSlice.reducer;