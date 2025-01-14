import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { fetchData } from '@/utils/api';
import { Trend } from '@/interfaces/Trend';

interface TrendsState {
  trends: Trend[];
  loading: boolean;
  error: string | null;
}

const initialState: TrendsState = {
  trends: [],
  loading: false,
  error: null,
};

export const fetchTrends = createAsyncThunk('trends/fetchTrends', async () => {
  const response = await fetchData('hashtags');
  return response.map((trend: any) => ({
    id: trend.id,
    text: trend.text,
    hashtag: trend.hashtag,
    score: trend.score,
    created_at: trend.created_at,
  }));
});

const trendsSlice = createSlice({
  name: 'trends',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchTrends.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchTrends.fulfilled, (state, action) => {
        state.loading = false;
        state.trends = action.payload;
      })
      .addCase(fetchTrends.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch trends';
      });
  },
});

export default trendsSlice.reducer;
