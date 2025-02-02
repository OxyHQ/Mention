import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { fetchData } from '@/utils/api';
import { Trend } from '@/interfaces/Trend';

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
  const response = await fetchData('hashtags');
  return response.hashtags.map((trend: any) => ({
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
