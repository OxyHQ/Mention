import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { Profile } from '@/interfaces/Profile';
import { fetchData, patchData } from '@/utils/api';

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

export const getUsernameToId = async ({ username }: { username: string }) => {
  const cleanUsername = username.startsWith('@') ? username.substring(1) : username;
  try {
    const response = await fetchData(`users/username-to-id/${cleanUsername}`);
    return response?.id || null;
  } catch (error) {
    console.error(error);
    return null;
  }
};

export const fetchProfile = createAsyncThunk(
  'profile/fetchProfile', 
  async ({ username }: { username: string }) => {
    const userId = await getUsernameToId({ username });
    if (!userId) {
      throw new Error('Failed to fetch user ID');
    }
    const response = await fetchData(`profiles/${userId}`);
    return response as Profile;
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
        state.error = action.error.message || 'Failed to fetch profile';
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
