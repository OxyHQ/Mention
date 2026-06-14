/**
 * Feed auth-gating decisions.
 *
 * A tiny, dependency-free module so the cold-boot auth-gating logic can be
 * unit-tested without pulling in React, Zustand, the SDK, or the network layer.
 *
 * The home feed renders across three auth lifecycle phases on web cold boot:
 *
 *   1. UNDETERMINED — the SDK's `isAuthResolved` is still `false`. The session
 *      restore has not concluded, so `isAuthenticated` is NOT yet a reliable
 *      answer. We must not fire the anonymous fetch (it would flash anon content
 *      before the session restores).
 *   2. AUTHED-ID-PENDING — auth has resolved (or the caller does not gate on
 *      resolution) and the viewer IS authenticated, but the full user id has not
 *      landed yet. The initial fetch is deferred (a tokenless request would be
 *      wasted) until the id arrives.
 *   3. RESOLVED — a definitive answer: authenticated with a known id, or a
 *      genuinely-anonymous visitor.
 *
 * During phases 1 and 2 the feed MUST show a spinner — never the empty
 * "No posts yet" placeholder, and never the anonymous feed variant — otherwise a
 * cold-boot reload with an existing session strands on empty/anon content.
 *
 * `isAuthResolved` is `undefined` for callers that do not gate on resolution
 * (e.g. profile feeds); they are treated as "resolved" so they are unaffected.
 */

export interface FeedAuthGateInput {
    /** `isAuthResolved` from the SDK. `undefined` = caller does not gate. */
    isAuthResolved?: boolean;
    /** Whether the viewer is authenticated (from the SDK). */
    isAuthenticated?: boolean;
    /** The authenticated viewer's full user id, once known. */
    currentUserId?: string;
}

/**
 * The cold-boot determination has not concluded yet. Only an explicit `false`
 * counts as undetermined; `undefined` (ungated callers) is treated as resolved.
 */
export function isAuthUndetermined(input: Pick<FeedAuthGateInput, 'isAuthResolved'>): boolean {
    return input.isAuthResolved === false;
}

/**
 * Auth has resolved (or the caller does not gate) and the viewer is
 * authenticated, but the full user id has not landed yet. The initial fetch is
 * deliberately skipped in this window, so the feed must report loading rather
 * than commit the empty placeholder.
 */
export function isAuthedIdentityPending(input: FeedAuthGateInput): boolean {
    return !isAuthUndetermined(input) && !!input.isAuthenticated && !input.currentUserId;
}

/**
 * The auth identity is still settling — either the determination is undetermined
 * or the authenticated viewer's id has not landed. While true, the feed shows a
 * spinner and must NOT mount in an anonymous configuration.
 */
export function isAuthIdentitySettling(input: FeedAuthGateInput): boolean {
    return isAuthUndetermined(input) || isAuthedIdentityPending(input);
}

/** Neutral sentinel feed identity used while the auth identity is settling. */
export const PENDING_FEED_IDENTITY = 'pending';

/** Feed identity for a genuinely-anonymous (resolved, unauthenticated) viewer. */
export const ANON_FEED_IDENTITY = 'anon';

/**
 * Resolve the feed-identity key that scopes a home <Feed> remount.
 *
 *   • settling  → `PENDING_FEED_IDENTITY` (spinner, never the anon variant)
 *   • authed    → the user id (remounts per account)
 *   • anonymous → `ANON_FEED_IDENTITY`
 *
 * Keeping this in lockstep with `isAuthIdentitySettling` is what prevents the
 * feed-identity key (in the screen) and the loading/guard logic (in the hook)
 * from disagreeing and stranding the feed.
 */
export function resolveFeedIdentity(input: FeedAuthGateInput): string {
    if (isAuthIdentitySettling(input)) return PENDING_FEED_IDENTITY;
    if (input.isAuthenticated && input.currentUserId) return input.currentUserId;
    return ANON_FEED_IDENTITY;
}
