import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { fetchData } from '@/utils/api';

const initialState: { users: any[], loading: boolean, error: string | null } = {
  users: [],
  loading: false,
  error: null,
};

export const fetchFollowRecommendations = createAsyncThunk('follow/fetchFollowRecommendations', async () => {
    const response = await fetchData('users');
    response.username = response.username ? response.username : response.id;
  return response;
});

const followSlice = createSlice({
  name: 'follow',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchFollowRecommendations.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchFollowRecommendations.fulfilled, (state, action) => {
        state.loading = false;
        state.users = action.payload;
      })
      .addCase(fetchFollowRecommendations.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch follow recommendations';
      });
  },
});

export default followSlice.reducer;
