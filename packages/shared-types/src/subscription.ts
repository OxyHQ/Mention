/**
 * Activity subscriptions — "notify me when this account posts".
 *
 * A subscription is a viewer-scoped edge onto an AUTHOR, entirely separate from
 * the follow graph: the viewer may or may not follow the author, and unlike a
 * follow it produces a per-post notification rather than a feed entry.
 *
 * The list endpoint (`GET /subscriptions`) hydrates each author server-side, so
 * the client never resolves identity itself.
 */

import type { PostUser } from './post';

/**
 * One subscription row.
 *
 * `author` is the canonical Oxy {@link PostUser} passed through UNCHANGED —
 * `name.displayName` is rendered directly, `avatar` stays a bare Oxy file id (or
 * an absolute federated URL) for Bloom's `ImageResolver`, and the handle is
 * derived with `getNormalizedUserHandle`. An author Oxy could not resolve
 * arrives degraded (empty `username`, `'Unknown user'`) — never as a raw id.
 */
export interface PostSubscriptionItem {
  author: PostUser;
  /** When the viewer subscribed, ISO 8601. Also the pagination sort key. */
  createdAt: string;
}

/**
 * One page of the viewer's subscriptions, newest first.
 *
 * `nextCursor` is an opaque keyset token echoed back as `?cursor=` to fetch the
 * following page; its ABSENCE is the end of the list.
 */
export interface PostSubscriptionListResponse {
  subscriptions: PostSubscriptionItem[];
  nextCursor?: string;
}
