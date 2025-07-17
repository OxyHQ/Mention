import { create } from 'zustand';
import api from '@/utils/api';
import { Trend } from '@/interfaces/Trend';

interface TrendsStore {
  trends: Trend[];
  isLoading: boolean;
  error: string | null;
  fetchTrends: () => Promise<void>;
}

export const useTrendsStore = create<TrendsStore>((set) => ({
  trends: [],
  isLoading: false,
  error: null,
  fetchTrends: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.get('hashtags');
      set({
        trends: response.data.hashtags.map((trend: any) => ({
          id: trend.id,
          text: trend.text,
          hashtag: trend.hashtag,
          score: trend.count,
          created_at: trend.created_at,
        })),
        isLoading: false,
      });
    } catch (error: any) {
      set({ error: error?.message || 'Failed to fetch trends', isLoading: false });
    }
  },
})); 