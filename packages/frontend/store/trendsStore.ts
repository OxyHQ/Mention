import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '@/utils/api';
import { Trend } from '@/interfaces/Trend';

/**
 * Slow safety-net poll. Realtime freshness is driven by the `trends:updated`
 * socket signal; this interval only covers the case where the socket is down.
 */
const POLL_INTERVAL_MS = 300_000; // 5 minutes

interface TrendApiItem {
  _id?: string;
  name: string;
  type?: Trend['type'];
  description?: string;
  score?: number;
  volume?: number;
  momentum?: number;
  rank?: number;
  calculatedAt?: string;
  updatedAt?: string;
}

interface TrendsApiResponse {
  trending?: TrendApiItem[];
  summary?: string;
}

interface TrendsStore {
  trends: Trend[];
  summary: string;
  isLoading: boolean;
  hasFetched: boolean;
  error: string | null;
  hiddenTrendIds: string[];
  fetchTrends: (opts?: { silent?: boolean }) => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  hideTrend: (id: string) => void;
}

function momentumToDirection(momentum: number): 'up' | 'down' | 'flat' {
  if (momentum > 0.3) return 'up';
  if (momentum < -0.1) return 'down';
  return 'flat';
}

let pollHandle: ReturnType<typeof setInterval> | null = null;

export const useTrendsStore = create<TrendsStore>()(
  persist(
    (set, get) => ({
      trends: [],
      summary: '',
      isLoading: false,
      hasFetched: false,
      error: null,
      hiddenTrendIds: [],

      fetchTrends: async (opts?: { silent?: boolean }) => {
        const silent = !!opts?.silent;
        if (!silent) set({ isLoading: true, error: null });
        try {
          const response = await api.get<TrendsApiResponse>('/trending', { limit: 10 });
          const items: TrendApiItem[] = response.data.trending || [];
          const next = items.map((item) => ({
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

          const { trends: prev, summary: prevSummary } = get();
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

          const nextSummary = response.data.summary || '';

          if (changed || prevSummary !== nextSummary) {
            set({ trends: next, summary: nextSummary, isLoading: false, hasFetched: true });
          } else {
            set({ isLoading: false, hasFetched: true });
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Failed to fetch trends';
          if (!silent) set({ error: message, isLoading: false });
        }
      },

      startPolling: () => {
        if (pollHandle) return;
        void get().fetchTrends();
        pollHandle = setInterval(() => {
          void get().fetchTrends({ silent: true });
        }, POLL_INTERVAL_MS);
      },

      stopPolling: () => {
        if (pollHandle) {
          clearInterval(pollHandle);
          pollHandle = null;
        }
      },

      hideTrend: (id: string) => {
        if (!id) return;
        const { hiddenTrendIds } = get();
        if (hiddenTrendIds.includes(id)) return;
        set({ hiddenTrendIds: [...hiddenTrendIds, id] });
      },
    }),
    {
      name: 'trends-hidden',
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist the user's hide preferences — never the volatile trends list.
      partialize: (state) => ({ hiddenTrendIds: state.hiddenTrendIds }),
    },
  ),
);
