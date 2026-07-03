import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { roomsService } from '@/lib/agoraConfig';
import type { Room } from '@syra.fm/live';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('LiveRoomsStore');

/**
 * Slow safety-net poll. Realtime freshness is driven by the
 * `rooms:live:updated` socket signal; this interval only covers the case where
 * the socket is down. Mirrors the lengthened trends fallback.
 */
const POLL_INTERVAL_MS = 300_000; // 5 minutes
const LIVE_ROOMS_STATUS = 'live';

interface LiveRoomsState {
  rooms: Room[];
  isLoading: boolean;
  hasFetched: boolean;
  error: string | null;
  hiddenRoomIds: string[];
}

interface LiveRoomsActions {
  fetchLiveRooms: (opts?: { silent?: boolean }) => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  hideRoom: (id: string) => void;
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
// Ref count of mounted consumers. The shared interval runs while at least one
// consumer is mounted and is cleared when the last one unmounts, so polling no
// longer leaks for the whole session.
let pollSubscribers = 0;

export const useLiveRoomsStore = create<LiveRoomsStore>()(
  persist(
    (set, get) => ({
      rooms: [],
      isLoading: true,
      hasFetched: false,
      error: null,
      hiddenRoomIds: [],

      fetchLiveRooms: async (opts?: { silent?: boolean }) => {
        const silent = !!opts?.silent;
        if (!silent) set({ isLoading: true, error: null });
        try {
          const next = await roomsService.getRooms(LIVE_ROOMS_STATUS);
          const { rooms: prev } = get();
          if (roomsEqual(prev, next)) {
            set({ isLoading: false, hasFetched: true });
          } else {
            set({ rooms: next, isLoading: false, hasFetched: true });
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Failed to load live rooms';
          logger.warn('Failed to fetch live rooms', { error });
          if (!silent) set({ error: message, isLoading: false, hasFetched: true });
        }
      },

      startPolling: () => {
        pollSubscribers += 1;
        if (pollHandle) return;
        void get().fetchLiveRooms();
        pollHandle = setInterval(() => {
          void get().fetchLiveRooms({ silent: true });
        }, POLL_INTERVAL_MS);
        // Non-Node runtimes (RN/web) return a numeric handle with no unref — the
        // optional chain no-ops there; on Node it keeps the loop from staying alive.
        pollHandle.unref?.();
      },

      stopPolling: () => {
        if (pollSubscribers > 0) pollSubscribers -= 1;
        if (pollSubscribers > 0 || !pollHandle) return;
        clearInterval(pollHandle);
        pollHandle = null;
      },

      hideRoom: (id: string) => {
        if (!id) return;
        const { hiddenRoomIds } = get();
        if (hiddenRoomIds.includes(id)) return;
        set({ hiddenRoomIds: [...hiddenRoomIds, id] });
      },
    }),
    {
      name: 'live-rooms-hidden',
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist the user's hide preferences — never the volatile room list.
      partialize: (state) => ({ hiddenRoomIds: state.hiddenRoomIds }),
    },
  ),
);
