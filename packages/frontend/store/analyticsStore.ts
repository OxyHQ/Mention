import { create } from 'zustand';
import { api } from '@/utils/api';

interface AnalyticsState {
  data: any;
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
    } catch (error: any) {
      set({ error: error?.message || 'Failed to fetch analytics', loading: false });
    }
  },
})); 