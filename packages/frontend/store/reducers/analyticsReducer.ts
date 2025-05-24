import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { fetchData } from '@/utils/api';

export const fetchAnalytics = createAsyncThunk(
  'analytics/fetchAnalytics',
  async ({ userID, period }: { userID: string; period: string }) => {
    const response = await fetchData(`analytics?userID=${userID}&period=${period}`);
    return response;
  }
);

interface AnalyticsState {
  data: any;
  loading: boolean;
  error: string | null;
}

const initialState: AnalyticsState = {
  data: null,
  loading: false,
  error: null,
};

const analyticsSlice = createSlice({
  name: 'analytics',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchAnalytics.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchAnalytics.fulfilled, (state, action) => {
        state.loading = false;
        state.data = action.payload;
      })
      .addCase(fetchAnalytics.rejected, (state, action) => {
        state.loading = false;
        state.error = action.error.message || 'Failed to fetch analytics';
      });
  },
});

export default analyticsSlice.reducer;