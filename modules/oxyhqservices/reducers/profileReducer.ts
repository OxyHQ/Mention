import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import type { Profile } from '../types';
import { fetchData, patchData } from '../utils/api';

interface ProfileState {
  profile: Profile | null;
  loading: boolean;
  error: string | null;
}

const initialState: ProfileState = {
  profile: null,
  loading: false,
  error: null,
};

export const getUsernameToId = async ({ username }: { username: string }): Promise<string | null> => {
  const cleanUsername = username.startsWith('@') ? username.substring(1) : username;
  try {
    const response = await fetchData(`users/username-to-id/${cleanUsername}`);
    if (!response?.id || typeof response.id !== 'string') {
      console.error('Invalid ID format received:', response);
      return null;
    }
    return response.id;
  } catch (error) {
    console.error('Error converting username to ID:', error);
    return null;
  }
};

export const fetchProfile = createAsyncThunk(
  'profile/fetchProfile', 
  async ({ username }: { username: string }, { rejectWithValue }) => {
    try {
      const userId = await getUsernameToId({ username });
      if (!userId || typeof userId !== 'string') {
        return rejectWithValue(`User not found: ${username}`);
      }
      
      const response = await fetchData(`profiles/${userId}`);
      if (!response) {
        return rejectWithValue('No profile data received');
      }
      return response;
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to fetch profile';
      return rejectWithValue(errorMessage);
    }
  }
);

export const updateProfileData = createAsyncThunk(
  'profile/updateProfileData',
  async ({ id, data }: { id: string; data: Partial<Profile> }, { rejectWithValue }) => {
    try {
      const response = await patchData(`profiles/${id}`, data);
      return response as Profile;
    } catch (error: any) {
      return rejectWithValue(error.response?.data?.message || 'Failed to update profile');
    }
  }
);

const profileSlice = createSlice({
  name: 'profile',
  initialState,
  reducers: {
    setProfile: (state, action) => {
      state.profile = action.payload;
      state.loading = false;
      state.error = null;
    },
    clearProfile: (state) => {
      state.profile = null;
      state.loading = false;
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
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
        state.error = action.payload as string || action.error.message || 'Failed to fetch profile';
      })
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
        state.error = (action.payload as string) || action.error.message || 'Failed to update profile';
      });
  },
});

export const { setProfile, clearProfile } = profileSlice.actions;
export default profileSlice.reducer;