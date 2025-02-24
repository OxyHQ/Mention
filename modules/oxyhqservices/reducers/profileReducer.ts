import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import type { OxyProfile } from '../types';
import { fetchData, patchData } from '../utils/api';

interface ProfileState {
  profile: OxyProfile | null;
  loading: boolean;
  error: string | null;
}

const initialState: ProfileState = {
  profile: null,
  loading: false,
  error: null,
};

export const getUsernameToId = async ({ username }: { username: string }): Promise<string | null> => {
  try {
    const response = await fetchData(`profiles/username/${username}`);
    return response?._id || null;
  } catch (error) {
    console.error('Error in getUsernameToId:', error);
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
      
      const response = await fetchData(`users/${userId}`);
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
  async ({ id, data }: { id: string; data: Partial<OxyProfile> }, { rejectWithValue }) => {
    try {
      const response = await patchData(`users/${id}`, data);
      return response as OxyProfile;
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