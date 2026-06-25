import { create } from 'zustand';
import { api } from '@/utils/api';
import { normalizeApiError } from '@/utils/apiError';

interface AnalyticsState {
  data: unknown;
  loading: boolean;
  error: string | null;
  fetchAnalytics: (userID: string, period: string) => Promise<void>;
}

export const useAnalyticsStore = create<AnalyticsState>((set) => ({
  data: null,
  loading: false,
  error: null,
  fetchAnalytics: async (userID: string, period: string) => {
    set({ loading: true, error: null });
    try {
      const response = await api.get('analytics', { userID, period });
      set({ data: response.data, loading: false });
    } catch (error: unknown) {
      set({ error: normalizeApiError(error).message || 'Failed to fetch analytics', loading: false });
    }
  },
})); 