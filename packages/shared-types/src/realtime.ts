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

/**
 * The room a client joins to watch ONE post's engagement counters.
 *
 * Derived from a post id the server has already checked this viewer may read —
 * see the `joinPost` handler in `packages/backend/server.ts`. The id travels
 * from the client, so the check is what makes the room safe; the key format
 * alone guarantees nothing.
 */
export const POST_ENGAGEMENT_ROOM_PREFIX = 'post:';

export const postEngagementRoom = (postId: string): string =>
  `${POST_ENGAGEMENT_ROOM_PREFIX}${postId}`;

/**
 * Server → client engagement events, emitted into {@link postEngagementRoom}.
 *
 * The name says which way the counter moved, so a client that renders nothing
 * but numbers can still ignore the ones it does not care about. The numbers
 * themselves are always authoritative — see {@link PostEngagementCountsPayload}.
 */
export const POST_ENGAGEMENT_EVENTS = {
  LIKED: 'post:liked',
  UNLIKED: 'post:unliked',
  BOOSTED: 'post:boosted',
  UNBOOSTED: 'post:unboosted',
  SAVED: 'post:saved',
  UNSAVED: 'post:unsaved',
  REPLIED: 'post:replied',
} as const;

export type PostEngagementEvent =
  (typeof POST_ENGAGEMENT_EVENTS)[keyof typeof POST_ENGAGEMENT_EVENTS];

/**
 * One post's counters after a write that changed them.
 *
 * ## Every number is the value the database holds, never a delta
 *
 * The emitter reads its counters back from the same `{ new: true }` update that
 * wrote them, so a client applies the number as-is. That is what makes the
 * events order-insensitive: two events that cross on the wire converge on
 * whichever the client saw last, and a client that misses one entirely is
 * corrected by the next. A delta would have to be applied exactly once, in
 * order, which no broadcast can promise.
 *
 * ## An ABSENT counter is not zero — it is "do not touch"
 *
 * Each counter is separately hidden by its author (`UserSettings.privacy.hide*Counts`),
 * and the hydrated DTO already sends `null` for a hidden one. Broadcasting the
 * real number to a room would put back exactly what the author asked to remove,
 * so a hidden counter is OMITTED here and the client leaves its rendered value
 * alone. `undefined` and `0` therefore mean different things; do not coalesce
 * them.
 *
 * ## `actorId` is present only when the action itself is public
 *
 * It is what lets a client discard the echo of its own action (which it already
 * applied optimistically) without depending on a timing window. Saves are
 * viewer-private, so save events carry the count and no actor — which is also
 * why no client can learn WHO saved a post from this room.
 */
export interface PostEngagementCountsPayload {
  postId: string;
  likesCount?: number;
  downvotesCount?: number;
  boostsCount?: number;
  repliesCount?: number;
  savesCount?: number;
  /** Oxy user id of whoever acted; omitted for actions that are not public. */
  actorId?: string;
  /** ISO timestamp of the write. */
  timestamp: string;
}
