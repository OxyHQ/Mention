/**
 * Realtime socket event names (server → client) that originate OUTSIDE this
 * repo, plus the timing constants that govern how the widgets react to them.
 *
 * Mention's own realtime contract is not duplicated here: the public namespace
 * and its events (trends) are defined once in `@mention/shared-types` and read
 * from there by both the server and this app, so the two can never drift.
 */

/** Live-rooms set changed. Payload: `{ reason?: 'created' | 'ended' | 'participants' }` (signal only). */
export const SOCKET_EVENT_ROOMS_LIVE_UPDATED = 'rooms:live:updated' as const;

/**
 * Coalesce participant churn: a burst of `rooms:live:updated` signals collapses
 * into a single silent refetch after this debounce window.
 */
export const ROOMS_LIVE_REFETCH_DEBOUNCE_MS = 400;

export interface RoomsLiveUpdatedPayload {
  reason?: 'created' | 'ended' | 'participants';
}
