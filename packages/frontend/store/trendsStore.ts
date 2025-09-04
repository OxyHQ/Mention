import { create } from 'zustand';
import { api } from '@/utils/api';
import { Trend } from '@/interfaces/Trend';

interface TrendsStore {
  trends: Trend[];
  isLoading: boolean;
  error: string | null;
  fetchTrends: (opts?: { silent?: boolean }) => Promise<void>;
}

export const useTrendsStore = create<TrendsStore>((set, get) => ({
  trends: [],
  isLoading: false,
  error: null,
  fetchTrends: async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (!silent) set({ isLoading: true, error: null });
    try {
      const response = await api.get('/hashtags');
      const next = response.data.hashtags.map((trend: any) => ({
        id: trend.id,
        text: trend.text,
        hashtag: trend.hashtag,
        score: trend.count,
        created_at: trend.created_at,
        direction: (trend.direction as any) || 'flat',
      })) as Trend[];

      // Only update trends if changed (length, order, score, direction)
      const prev = get().trends || [];
      let changed = prev.length !== next.length;
      if (!changed) {
        for (let i = 0; i < next.length; i++) {
          const a = prev[i];
          const b = next[i];
          if (!a || !b || a.id !== b.id || a.score !== b.score || (a.direction || 'flat') !== (b.direction || 'flat')) {
            changed = true;
            break;
          }
        }
      }

      if (changed) {
        set({ trends: next, isLoading: false });
      } else if (!silent) {
        // Ensure loading flag resets for non-silent calls
        set({ isLoading: false });
      }
    } catch (error: any) {
      const message = error?.message || 'Failed to fetch trends';
      if (!silent) set({ error: message, isLoading: false });
    }
  },
})); 
