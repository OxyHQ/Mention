/**
 * Realtime socket event names (server → client) and the timing constants that
 * govern how the trends / live-rooms widgets react to them.
 *
 * Hoisted here so the socket service, the stores, and the widgets all reference
 * the SAME frozen contract — no stringly-typed event names sprinkled around.
 */

/** Trends recalculated server-side. Payload: `{ calculatedAt?: string }` (signal only). */
export const SOCKET_EVENT_TRENDS_UPDATED = 'trends:updated' as const;

/** Live-rooms set changed. Payload: `{ reason?: 'created' | 'ended' | 'participants' }` (signal only). */
export const SOCKET_EVENT_ROOMS_LIVE_UPDATED = 'rooms:live:updated' as const;

/**
 * Coalesce participant churn: a burst of `rooms:live:updated` signals collapses
 * into a single silent refetch after this debounce window.
 */
export const ROOMS_LIVE_REFETCH_DEBOUNCE_MS = 400;

export interface TrendsUpdatedPayload {
  calculatedAt?: string;
}

export interface RoomsLiveUpdatedPayload {
  reason?: 'created' | 'ended' | 'participants';
}
