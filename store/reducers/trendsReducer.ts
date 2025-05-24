import { Trend } from '@/interfaces/Trend';
import { fetchData } from '@/utils/api';
import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';

interface TrendsState {
  trends: Trend[];
  isLoading: boolean; // Change loading to isLoading
  error: string | null;
}

const initialState: TrendsState = {
  trends: [],
  isLoading: true, // Change loading to isLoading
  error: null,
};

export const fetchTrends = createAsyncThunk('trends/fetchTrends', async () => {
  const response = await fetchData('hashtags') as { hashtags: any[] };
  return response.hashtags.map((trend: any) => ({
    id: trend.id,
    text: trend.text,
    hashtag: trend.hashtag,
    score: trend.count,
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
        state.isLoading = true; // Change loading to isLoading
        state.error = null;
      })
      .addCase(fetchTrends.fulfilled, (state, action) => {
        state.isLoading = false; // Change loading to isLoading
        state.trends = action.payload;
      })
      .addCase(fetchTrends.rejected, (state, action) => {
        state.isLoading = false; // Change loading to isLoading
        state.error = action.error.message || 'Failed to fetch trends';
      });
  },
});

export default trendsSlice.reducer;
