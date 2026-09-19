/**
 * `GET /search/overview` — the wire contract for the one-request search fan-out.
 *
 * ## What this replaces
 *
 * The search screen used to issue SEVEN requests across THREE hosts and await
 * all of them (`Promise.allSettled`), so the overview rendered at the speed of
 * the slowest lane and every lane paid its own auth, its own viewer-context
 * resolution and its own round trip. One request replaces that.
 *
 * ## Every lane key is ALWAYS present, with an explicit status
 *
 * This is the part worth defending, because the obvious shape — omit a lane
 * that returned nothing — is the one that loses information. An absent key and
 * an empty array are indistinguishable on the wire, so the client cannot tell
 * "nothing matched" from "this lane fell over", and it renders a confident
 * "no results" for a failure. That is precisely what `Promise.allSettled`
 * discarded on the client, and moving the fan-out to the server without fixing
 * it would carry the defect across.
 *
 * So: every lane, every time, with a `status` that says which happened.
 */

/** The lanes an overview can carry. */
export type SearchLaneName =
  | 'profiles'
  | 'posts'
  | 'hashtags'
  | 'lists'
  | 'feeds'
  | 'starterPacks'
  | 'saved';

/**
 * Why a lane holds what it holds.
 *
 * - `ok` — it ran and these are its results, empty or not.
 * - `timeout` — it exceeded its budget. The response did not wait for it.
 * - `error` — it failed. NOT "no results"; the client must not render an empty
 *   state for this.
 * - `skipped` — deliberately not run for this request (an anonymous viewer has
 *   no saved posts; `profiles` is served by Oxy and is not folded in yet).
 * - `unavailable` — the lane exists but this deployment cannot serve it.
 *
 * `timeout` and `error` are separate because they call for different UI: a
 * timeout is worth retrying and an error usually is not.
 */
export type SearchLaneStatus = 'ok' | 'timeout' | 'error' | 'skipped' | 'unavailable';

/** One lane's slice of the overview. */
export interface SearchLane<T> {
  status: SearchLaneStatus;
  /** Always an array. Empty for every status other than `ok`. */
  items: T[];
  /** Whether the per-lane endpoint has more beyond this page. */
  hasMore: boolean;
  /**
   * The token to continue this lane against its OWN endpoint.
   *
   * The overview is not a pagination engine: it returns one small page per lane
   * and hands back the cursor so the dedicated tab can continue from it rather
   * than restarting at page one. Opaque — pass it back unchanged.
   */
  nextCursor?: string;
  /** Wall-clock milliseconds this lane took. Present so a slow lane is visible. */
  tookMs: number;
}

/**
 * The overview response.
 *
 * `lanes` is a total map: every {@link SearchLaneName} is present. The item
 * types are intentionally loose here (`unknown[]` at the boundary, narrowed by
 * the caller against the per-entity types this package already exports) because
 * the overview carries six different row shapes and a union would force every
 * consumer through a discriminant it does not need — the lane KEY is the
 * discriminant.
 */
export interface SearchOverviewResponse {
  /** The query as the server understood it, after trimming and normalisation. */
  query: string;
  lanes: Record<SearchLaneName, SearchLane<unknown>>;
  /**
   * True when any lane is not `ok`.
   *
   * A single field the client can branch on without walking the map, so
   * "something is missing from this page" is one check rather than seven.
   */
  degraded: boolean;
  /** Whether this body came from the shared overview cache. */
  servedFromCache: boolean;
}

/** Page size the overview returns per lane. Small: it is a preview, not a page. */
export const SEARCH_OVERVIEW_LANE_LIMIT = 5;

/**
 * Every lane name, in the order the overview renders them.
 *
 * Exported so the server can build a total map and the client can iterate
 * without either restating the list — a lane added to the type but missing from
 * one of the two is the drift this prevents.
 */
export const SEARCH_LANE_NAMES: readonly SearchLaneName[] = [
  'profiles',
  'posts',
  'hashtags',
  'lists',
  'feeds',
  'starterPacks',
  'saved',
] as const;
