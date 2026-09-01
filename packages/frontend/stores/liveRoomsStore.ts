import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLiveRooms, type Room } from '@/lib/syraApi';
import { createLogger } from '@oxyhq/core/logger';

const logger = createLogger('LiveRoomsStore');

/**
 * Slow safety-net poll. Realtime freshness is driven by the
 * `rooms:live:updated` socket signal; this interval only covers the case where
 * the socket is down. Mirrors the lengthened trends fallback.
 */
const POLL_INTERVAL_MS = 300_000; // 5 minutes
const LIVE_ROOMS_STATUS = 'live';

interface LiveRoomsState {
  rooms: Room[];
  hasFetched: boolean;
  error: string | null;
  hiddenRoomIds: string[];
}

interface LiveRoomsActions {
  fetchLiveRooms: (opts?: { silent?: boolean }) => Promise<void>;
  startPolling: () => number;
  stopPolling: (subscriptionId: number) => void;
  hideRoom: (id: string) => void;
  resetViewerState: () => void;
}

type LiveRoomsStore = LiveRoomsState & LiveRoomsActions;

function roomsEqual(prev: Room[], next: Room[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) {
    const a = prev[i];
    const b = next[i];
    if (!a || !b) return false;
    if (a._id !== b._id) return false;
    if (a.status !== b.status) return false;
    if ((a.participants?.length || 0) !== (b.participants?.length || 0)) return false;
    if (a.title !== b.title) return false;
  }
  return true;
}

let pollHandle: ReturnType<typeof setInterval> | null = null;
let viewerEpoch = 0;
const LEGACY_STORAGE_KEY = 'live-rooms-hidden';
// Lease IDs keep a delayed cleanup from the old identity from decrementing a
// newly mounted viewer's subscription after resetViewerState().
const pollSubscriptions = new Set<number>();
let nextPollSubscriptionId = 1;

export const useLiveRoomsStore = create<LiveRoomsStore>()(
    (set, get) => ({
      rooms: [],
      hasFetched: false,
      error: null,
      hiddenRoomIds: [],

      fetchLiveRooms: async (opts?: { silent?: boolean }) => {
        const operationEpoch = viewerEpoch;
        const silent = !!opts?.silent;
        if (!silent) set({ error: null });
        try {
          const next = await getLiveRooms(LIVE_ROOMS_STATUS);
          if (operationEpoch !== viewerEpoch) return;
          const { rooms: prev } = get();
          if (roomsEqual(prev, next)) {
            set({ hasFetched: true });
          } else {
            set({ rooms: next, hasFetched: true });
          }
        } catch (error: unknown) {
          if (operationEpoch !== viewerEpoch) return;
          const message = error instanceof Error ? error.message : 'Failed to load live rooms';
          logger.warn('Failed to fetch live rooms', { error });
          if (!silent) set({ error: message, hasFetched: true });
        }
      },

      startPolling: () => {
        const subscriptionId = nextPollSubscriptionId;
        nextPollSubscriptionId += 1;
        pollSubscriptions.add(subscriptionId);
        if (pollHandle) return subscriptionId;
        void get().fetchLiveRooms();
        pollHandle = setInterval(() => {
          void get().fetchLiveRooms({ silent: true });
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

      hideRoom: (id: string) => {
        if (!id) return;
        const { hiddenRoomIds } = get();
        if (hiddenRoomIds.includes(id)) return;
        set({ hiddenRoomIds: [...hiddenRoomIds, id] });
      },

      resetViewerState: () => {
        viewerEpoch += 1;
        pollSubscriptions.clear();
        if (pollHandle) {
          clearInterval(pollHandle);
          pollHandle = null;
        }
        set({
          rooms: [],
          hasFetched: false,
          error: null,
          hiddenRoomIds: [],
        });
        // v1 persisted hide choices without an owner. Never hydrate them into a
        // different account; remove the legacy payload at the identity boundary.
        void AsyncStorage.removeItem(LEGACY_STORAGE_KEY).catch(() => {});
      },
    }),
);
