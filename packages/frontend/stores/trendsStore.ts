import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '@/utils/api';
import type { Trend } from '@/interfaces/Trend';

/**
 * Slow safety-net poll. Realtime freshness is driven by the `trends:updated`
 * socket signal; this interval only covers the case where the socket is down.
 */
const POLL_INTERVAL_MS = 300_000; // 5 minutes

interface TrendApiItem {
  // The wire carries a per-batch `_id`; it is deliberately not read. See
  // `trendIdentity` for why a row id is the wrong identity for a trend.
  name: string;
  type?: Trend['type'];
  description?: string;
  score?: number;
  volume?: number;
  momentum?: number;
  rank?: number;
  calculatedAt?: string;
  updatedAt?: string;
  /** Recent `volume` history, oldest first. Absent when the server has too little. */
  series?: unknown;
}

/**
 * Accept a wire `series` only if it is genuinely an array of finite numbers.
 *
 * The sparkline turns these straight into SVG coordinates, so one `null` or
 * `NaN` from a malformed response would poison the whole polyline rather than
 * spoiling a single point. Anything unexpected drops the series entirely, which
 * the row already knows how to render: as no chart at all.
 */
function parseSeries(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((point) => typeof point === 'number' && Number.isFinite(point))
    ? (value as number[])
    : undefined;
}

interface TrendsApiResponse {
  trending?: TrendApiItem[];
  summary?: string;
  /**
   * Batch token, at the TOP LEVEL of the response because it identifies the
   * batch rather than any one trend. Stamped onto every mapped trend so a press
   * reported from any surface can carry it back. Absent on older responses.
   */
  recId?: string;
}

interface TrendsStore {
  trends: Trend[];
  summary: string;
  isLoading: boolean;
  hasFetched: boolean;
  error: string | null;
  hiddenTrendIds: string[];
  fetchTrends: (opts?: { silent?: boolean }) => Promise<void>;
  resyncAfterReconnect: () => void;
  startPolling: () => number;
  stopPolling: (subscriptionId: number) => void;
  hideTrend: (id: string) => void;
  resetViewerState: () => void;
}

/**
 * The identity of a TREND, not of the row that happened to carry it.
 *
 * The server inserts a fresh `Trending` document for every name in every batch,
 * so its `_id` changes each time the job runs even when the trend is the same
 * one. Using that as the client-side id made three separate things wrong:
 *
 *  - It is the React list key. A new key every batch UNMOUNTS each row and
 *    mounts a replacement, so the sparkline's whole SVG subtree was thrown away
 *    and rebuilt on every update. That repaint hides a frozen memo — a chart
 *    that never re-derived its geometry would still show the new shape, because
 *    it was a brand-new chart — which is exactly the failure a "the line moved"
 *    check is supposed to be able to see.
 *  - It is the key `hideTrend` records. Hiding a trend lasted only until the
 *    next batch, after which the same trend came back under a new id.
 *  - It is the first thing `fetchTrends` compares to decide whether anything
 *    changed. Comparing ids that differ by construction made that answer
 *    unconditionally "yes", so none of the careful comparison below it could
 *    ever take effect.
 *
 * `type` is part of the key because a hashtag and a topic can legitimately share
 * a name — the server's own unique index is `{ name, calculatedAt, type }`.
 */
function trendIdentity(type: NonNullable<Trend['type']>, name: string): string {
  return `${type}:${name}`;
}

function momentumToDirection(momentum: number): 'up' | 'down' | 'flat' {
  if (momentum > 0.3) return 'up';
  if (momentum < -0.1) return 'down';
  return 'flat';
}

let pollHandle: ReturnType<typeof setInterval> | null = null;
let viewerEpoch = 0;
const LEGACY_STORAGE_KEY = 'trends-hidden';
// Lease IDs keep delayed cleanup from an old identity from touching a new
// viewer's subscriber count after resetViewerState().
const pollSubscriptions = new Set<number>();
let nextPollSubscriptionId = 1;

export const useTrendsStore = create<TrendsStore>()(
    (set, get) => ({
      trends: [],
      summary: '',
      isLoading: false,
      hasFetched: false,
      error: null,
      hiddenTrendIds: [],

      fetchTrends: async (opts?: { silent?: boolean }) => {
        const operationEpoch = viewerEpoch;
        const silent = !!opts?.silent;
        if (!silent) set({ isLoading: true, error: null });
        try {
          const response = await api.get<TrendsApiResponse>('/trending', { limit: 10 });
          if (operationEpoch !== viewerEpoch) return;
          const items: TrendApiItem[] = response.data.trending || [];
          const recId = response.data.recId;
          const next = items.map((item) => {
            const series = parseSeries(item.series);
            const type = item.type || 'hashtag';
            return {
              id: trendIdentity(type, item.name),
              type,
              text: item.name,
              hashtag: item.type === 'hashtag' ? `#${item.name}` : item.name,
              description: item.description || '',
              score: item.score || 0,
              volume: item.volume || 0,
              momentum: item.momentum || 0,
              rank: item.rank || 0,
              created_at: item.calculatedAt || item.updatedAt || '',
              direction: momentumToDirection(item.momentum || 0),
              ...(recId ? { recId } : {}),
              ...(series ? { series } : {}),
            };
          }) as Trend[];

          const { trends: prev, summary: prevSummary } = get();
          let changed = prev.length !== next.length;
          if (!changed) {
            for (let i = 0; i < next.length; i++) {
              const a = prev[i];
              const b = next[i];
              // `recId` counts as a change even when the trends themselves are
              // identical: a rotated batch whose content happens to match would
              // otherwise keep the old token in state, and every press reported
              // afterwards would be labelled `stale` for no reason.
              // The series is compared explicitly rather than left to `recId`:
              // the token is absent whenever a cache entry predates it, and a
              // sparkline that silently kept yesterday's shape would be the
              // quiet version of the invented geometry this chart replaced.
              if (
                !a ||
                !b ||
                a.id !== b.id ||
                a.score !== b.score ||
                a.direction !== b.direction ||
                a.recId !== b.recId ||
                a.series?.join() !== b.series?.join()
              ) {
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
          if (operationEpoch !== viewerEpoch) return;
          const message = error instanceof Error ? error.message : 'Failed to fetch trends';
          if (!silent) set({ error: message, isLoading: false });
        }
      },

      /**
       * Re-sync after the socket reconnects, because a client that was asleep or
       * disconnected missed every `trends:updated` broadcast in between.
       *
       * This refetches the WHOLE list, which is the only reason the volume series
       * cannot silently develop gaps: `fetchTrends` replaces `trends` outright, so
       * a client that slept through six batches gets the current twelve points
       * rather than a line with six missing samples. There is no delta or append
       * path in this feature at all — the absence of one is the guarantee.
       *
       * A client that has never fetched has no stale series to repair, and most
       * clients never render a trend at all, so `hasFetched` keeps the reconnect
       * storm off the API for everyone but the surfaces that actually show one.
       */
      resyncAfterReconnect: () => {
        if (!get().hasFetched) return;
        void get().fetchTrends({ silent: true });
      },

      startPolling: () => {
        const subscriptionId = nextPollSubscriptionId;
        nextPollSubscriptionId += 1;
        pollSubscriptions.add(subscriptionId);
        if (pollHandle) return subscriptionId;
        void get().fetchTrends();
        pollHandle = setInterval(() => {
          void get().fetchTrends({ silent: true });
        }, POLL_INTERVAL_MS);
        // Non-Node runtimes (RN/web) return a numeric handle with no unref — the
        // optional chain no-ops there; on Node it keeps the loop from staying alive.
        pollHandle.unref?.();
        return subscriptionId;
      },

      stopPolling: (subscriptionId) => {
        pollSubscriptions.delete(subscriptionId);
        if (pollSubscriptions.size > 0 || !pollHandle) return;
        clearInterval(pollHandle);
        pollHandle = null;
      },

      hideTrend: (id: string) => {
        if (!id) return;
        const { hiddenTrendIds } = get();
        if (hiddenTrendIds.includes(id)) return;
        set({ hiddenTrendIds: [...hiddenTrendIds, id] });
      },

      resetViewerState: () => {
        viewerEpoch += 1;
        pollSubscriptions.clear();
        if (pollHandle) {
          clearInterval(pollHandle);
          pollHandle = null;
        }
        set({
          trends: [],
          summary: '',
          isLoading: false,
          hasFetched: false,
          error: null,
          hiddenTrendIds: [],
        });
        // v1 persisted hide choices globally. Remove the unowned value instead
        // of letting a second account inherit it.
        void AsyncStorage.removeItem(LEGACY_STORAGE_KEY).catch(() => {});
      },
    }),
);
