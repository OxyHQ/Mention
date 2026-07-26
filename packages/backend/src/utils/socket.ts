import { getRuntimeSocketServer } from '../runtime/socketServer';

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
} as const;

export interface TrendsUpdatedPayload {
  calculatedAt?: string;
}

/**
 * Broadcast a lightweight trends-updated signal on the main namespace.
 * The runtime seam is the single Socket.IO owner. It stays a no-op in
 * tests/scripts that intentionally do not bind a server.
 */
export const emitTrendsUpdated = (calculatedAt: string): void => {
  const payload: TrendsUpdatedPayload = { calculatedAt };
  getRuntimeSocketServer()?.emit(SOCKET_EVENTS.TRENDS_UPDATED, payload);
};
