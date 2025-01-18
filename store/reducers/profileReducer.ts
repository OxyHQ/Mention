import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { Profile } from '@/interfaces/Profile';
import { fetchData, fetchDataOxy } from '@/utils/api';

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
  try {
    const response = await fetchDataOxy(`users/username-to-id/${username}`);
    const ProfileData = response;

    return ProfileData?.id || null;
  } catch (error) {
    console.error(error);
    return null;
  }
};

export const fetchProfile = createAsyncThunk('profile/fetchProfile', async ({ username }: { username: string }) => {
  const userId = await getUsernameToId({ username });
  if (!userId) {
    throw new Error('Failed to fetch user ID');
  }
  const response = await fetchDataOxy(`profiles/${userId}`);
  return response as Profile;
});

const profileSlice = createSlice({
  name: 'profile',
  initialState,
  reducers: {
    updateProfile: (state, action) => {
      state.profile = action.payload;
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
      });
  },
});

export const { updateProfile } = profileSlice.actions;
export default profileSlice.reducer;
