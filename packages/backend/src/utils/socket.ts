import { Server as SocketIOServer } from 'socket.io';

/**
 * Main-namespace (default) broadcast event names.
 *
 * These are lightweight SIGNALS — clients refetch the underlying data on
 * receipt rather than reading a full payload off the wire. They are emitted on
 * the MAIN io instance (NOT a sub-namespace) so the frontend `socketService`,
 * which connects on the default namespace, receives them.
 */
export const SOCKET_EVENTS = {
  /** Trending data recalculated. Payload: `{ calculatedAt?: string }`. */
  TRENDS_UPDATED: 'trends:updated',
  /** The set of live rooms or a live room's participant count changed. Payload: `{ reason?: LiveRoomsUpdateReason }`. */
  ROOMS_LIVE_UPDATED: 'rooms:live:updated',
} as const;

/** Reason a `rooms:live:updated` signal was emitted. */
export type LiveRoomsUpdateReason = 'created' | 'ended' | 'participants';

export interface TrendsUpdatedPayload {
  calculatedAt?: string;
}

export interface LiveRoomsUpdatedPayload {
  reason?: LiveRoomsUpdateReason;
}

let io: SocketIOServer | null = null;

export const initializeIO = (socketIO: SocketIOServer) => {
  io = socketIO;
};

export const getIO = () => {
  return io;
};

export const closeIO = () => {
  if (io) {
    io.close();
    io = null;
  }
};

/**
 * Broadcast a lightweight live-rooms-changed signal on the main namespace.
 * Null-guarded: a no-op when `io` is uninitialized (tests/scripts).
 */
export const emitLiveRoomsUpdated = (reason: LiveRoomsUpdateReason): void => {
  const payload: LiveRoomsUpdatedPayload = { reason };
  io?.emit(SOCKET_EVENTS.ROOMS_LIVE_UPDATED, payload);
};

/**
 * Broadcast a lightweight trends-updated signal on the main namespace.
 * Null-guarded: a no-op when `io` is uninitialized (tests/scripts).
 */
export const emitTrendsUpdated = (calculatedAt: string): void => {
  const payload: TrendsUpdatedPayload = { calculatedAt };
  io?.emit(SOCKET_EVENTS.TRENDS_UPDATED, payload);
};