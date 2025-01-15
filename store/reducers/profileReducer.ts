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

export const fetchProfile = createAsyncThunk('profile/fetchProfile', async () => {
  const username = 'nate';
  const userId = await getUsernameToId({ username });
  if (!userId) {
    throw new Error('Failed to fetch user ID');
  }
  const response = await fetchDataOxy(`users/clwnmb0xd000010cy3lyqu6v0`);
  const responseData = response;
  responseData.avatar = "https://scontent-bcn1-1.xx.fbcdn.net/v/t39.30808-6/463417298_3945442859019280_8807009322776007473_n.jpg?_nc_cat=111&ccb=1-7&_nc_sid=6ee11a&_nc_ohc=zXRqATKNOw0Q7kNvgHnyfUU&_nc_oc=AdgYVSd5vfuRV96_nxCmCnemTuCfkgS2YQ_Diu1puFc_h76AbObPG9_eD5rFA5TcRxYnE2mW_ZfJKWuXYtX-Z8ue&_nc_zt=23&_nc_ht=scontent-bcn1-1.xx&_nc_gid=AqvR1nQbgt2nJudR3eAKaLM&oh=00_AYBD3grUDwAE84jgvGS3UmB93xn3odRDqePjARpVj6L2vQ&oe=678C0857";
  responseData.bio = responseData?.description;
  return responseData;
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
