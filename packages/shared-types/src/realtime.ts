/**
 * The PUBLIC realtime namespace — the one Socket.IO namespace on this server
 * that carries no authentication middleware.
 *
 * ## Why it exists
 *
 * Trending is a public surface: a signed-out visitor sees the widget and
 * `/explore/trending`. Every other namespace on this server (`/`,
 * `/notifications`, `/posts`) is behind `oxy.authSocket()`, so an anonymous
 * client cannot connect to any of them and had no way to receive a push at all
 * — it fell back to a slow safety-net poll. This namespace closes that gap
 * WITHOUT weakening any existing one.
 *
 * ## ADMISSION RULE — read before adding an event here
 *
 * An event may be emitted on this namespace only if it is **public by
 * definition**: the exact same bytes would be served to an anonymous HTTP
 * request. Concretely, an event qualifies only when ALL of these hold.
 *
 * 1. It is a **broadcast to everyone**. There are no rooms on this namespace,
 *    and there never will be — a room key would have to come from client input,
 *    and rooms must derive from `socket.user.id`, which does not exist here.
 * 2. It carries **no viewer-scoped data**. Not a user id, not a count that
 *    differs per viewer, not anything gated by follow/block/visibility.
 * 3. It is a **notice, not a payload**: enough to say "refetch", nothing more.
 *    The client re-reads through the normal cached public endpoint, which is
 *    what applies the viewer's filters and the server's coverage rules.
 *
 * Anything failing any one of those belongs on an authenticated namespace.
 * There is no "mostly public" case: this namespace has no identity to check
 * against, so a mistake here is a disclosure to the open internet.
 */
export const PUBLIC_REALTIME_NAMESPACE = '/public';

/**
 * Server → client events on {@link PUBLIC_REALTIME_NAMESPACE}.
 *
 * Every member must satisfy the admission rule documented above. Trends are the
 * first and, at time of writing, only member.
 */
export const PUBLIC_REALTIME_EVENTS = {
  /**
   * A trending batch was recalculated and published.
   *
   * A NOTICE, deliberately: the ~40 bytes here say only "there is a new batch".
   * Inlining the trend list would create a second serialization authority that
   * ignores the reader's `limit`/`type` filters and the series coverage floor,
   * would ship bytes to the many clients that render no trend at all, and would
   * bypass the Redis cache the batch job warms on purpose. The client refetches
   * `GET /trending` — the one cached, filtered path.
   */
  TRENDS_UPDATED: 'trends:updated',
} as const;

/** Payload of {@link PUBLIC_REALTIME_EVENTS.TRENDS_UPDATED}. */
export interface TrendsUpdatedPayload {
  /** ISO timestamp of the batch that was just published. */
  calculatedAt?: string;
}
