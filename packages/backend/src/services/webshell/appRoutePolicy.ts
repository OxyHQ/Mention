/**
 * What a search engine is told about an apex page the app shell answers.
 *
 * Every apex path that is not a federation endpoint, an asset or one of the web
 * shell's own pages (`/`, `/@…`, `/p/…`, `/c/…`, `/hashtag/…`) is answered with
 * the SPA's `index.html` (the shell Worker's `not_found_handling`). Before this,
 * every one of those answered `200` with the bare shell: no canonical, no
 * robots, the title "Mention" — `/random-garbage`, `/settings` and `/search?q=`
 * alike. A search engine sees a 200 with no content as a soft 404, and an app
 * screen nobody can read signed out as a duplicate of the homepage.
 *
 * - A path whose first segment no route of the app starts with is a real `404`.
 *   The body is still the shell, so a person who follows a bad link sees the
 *   app's own not-found screen as before.
 * - A route that is a signed-in tool or a utility (settings, compose,
 *   notifications, search results, an edit or create form, a post's list of
 *   reposts) is `noindex` by `X-Robots-Tag`. Its in-app `<SEO>` already says
 *   `noindex` once the app has rendered; the header says it before.
 * - Every other app route is left as it was: its in-app `<SEO>` decides.
 *
 * {@link APP_ROUTE_FIRST_SEGMENTS} must list every first segment of the app's
 * routes. `appRoutePolicy.test.ts` derives that set from
 * `packages/frontend/app` and fails when a route is added without it, so a new
 * page cannot start life as a 404.
 */

/**
 * The first path segment of every static app route (`packages/frontend/app`,
 * route groups removed). A profile (`/@user`) is the one dynamic first segment
 * and is matched separately.
 */
export const APP_ROUTE_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  'c',
  'camera',
  'channels',
  'checkout-playground',
  'communities',
  'community-notes',
  'compose',
  'deck',
  'edit-profile',
  'events',
  'explore',
  'feeds',
  'hashtag',
  'insights',
  'jobs',
  'lanes',
  'lists',
  'live-rooms',
  'memberships',
  'mention',
  'moderation',
  'notifications',
  'p',
  'plus',
  'saved',
  'search',
  'settings',
  'signup',
  'starter-packs',
  't',
  'trend-graph',
  'video-upload',
  'videos',
  'watch',
  'welcome',
  'write',
  'you',
]);

/**
 * First segments that are a signed-in tool or a utility on every path below
 * them: nothing a signed-out reader can use, nothing to index.
 */
const NOINDEX_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  'camera',
  'checkout-playground',
  'compose',
  'deck',
  'edit-profile',
  'insights',
  'memberships',
  'mention',
  'moderation',
  'notifications',
  'plus',
  'saved',
  'search',
  'settings',
  'video-upload',
  'write',
  'you',
]);

/** A last segment that makes any page a form, not content. */
const NOINDEX_LAST_SEGMENTS: ReadonlySet<string> = new Set([
  'applications',
  'apply',
  'bans',
  'create',
  'edit',
  'new',
]);

export interface AppRoutePolicy {
  /** The status the document is served with: 200, or 404 for a path no route answers. */
  status: 200 | 404;
  /** Whether the response carries `X-Robots-Tag: noindex`. */
  noindex: boolean;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The search policy for an apex document the app shell answers, by its path. */
export function appRoutePolicy(path: string): AppRoutePolicy {
  const segments = path.split('/').filter(Boolean).map(decodeSegment);
  const first = segments[0];
  if (first === undefined) return { status: 200, noindex: false };
  if (first.startsWith('@')) return { status: 200, noindex: false };
  if (!APP_ROUTE_FIRST_SEGMENTS.has(first)) return { status: 404, noindex: true };

  const last = segments[segments.length - 1];
  const noindex =
    NOINDEX_FIRST_SEGMENTS.has(first) ||
    (segments.length > 1 && NOINDEX_LAST_SEGMENTS.has(last)) ||
    // A post's reposts, quotes, boost and corrections: lists about a post,
    // whose page is the one to index.
    (first === 'p' && segments.length > 2) ||
    // A channel's settings and insights are its owner's tools.
    (first === 'c' && segments.length > 2 && (last === 'settings' || last === 'insights'));
  return { status: 200, noindex };
}
