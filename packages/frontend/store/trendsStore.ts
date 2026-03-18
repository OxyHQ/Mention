import { create } from 'zustand';
import { api } from '@/utils/api';
import { Trend } from '@/interfaces/Trend';

interface TrendsStore {
  trends: Trend[];
  isLoading: boolean;
  error: string | null;
  fetchTrends: (opts?: { silent?: boolean }) => Promise<void>;
}

function momentumToDirection(momentum: number): 'up' | 'down' | 'flat' {
  if (momentum > 0.3) return 'up';
  if (momentum < -0.1) return 'down';
  return 'flat';
}

export const useTrendsStore = create<TrendsStore>((set, get) => ({
  trends: [],
  isLoading: false,
  error: null,
  fetchTrends: async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (!silent) set({ isLoading: true, error: null });
    try {
      const response = await api.get('/trending', { params: { limit: 10 } });
      const next = (response.data.trending || []).map((item: any) => ({
        id: item._id || item.name,
        type: item.type || 'hashtag',
        text: item.name,
        hashtag: item.type === 'hashtag' ? `#${item.name}` : item.name,
        description: item.description || '',
        score: item.score || 0,
        volume: item.volume || 0,
        momentum: item.momentum || 0,
        rank: item.rank || 0,
        created_at: item.calculatedAt || item.updatedAt || '',
        direction: momentumToDirection(item.momentum || 0),
      })) as Trend[];

      // Only update if data changed
      const prev = get().trends || [];
      let changed = prev.length !== next.length;
      if (!changed) {
        for (let i = 0; i < next.length; i++) {
          const a = prev[i];
          const b = next[i];
          if (!a || !b || a.id !== b.id || a.score !== b.score || a.direction !== b.direction) {
            changed = true;
            break;
          }
        }
      }

      if (changed) {
        set({ trends: next, isLoading: false });
      } else if (!silent) {
        set({ isLoading: false });
      }
    } catch (error: any) {
      const message = error?.message || 'Failed to fetch trends';
      if (!silent) set({ error: message, isLoading: false });
    }
  },
}));
