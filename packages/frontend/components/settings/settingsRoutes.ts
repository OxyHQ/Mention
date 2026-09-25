/**
 * Settings addresses, and the one way to open Settings from outside React.
 *
 * Settings is a modal, not a screen. A `/settings/*` address therefore never
 * becomes a stack entry on native: an incoming link is intercepted in
 * `app/+native-intent.tsx` and handed to the provider through
 * `requestSettings`. Pushing the compatibility route and popping it on mount
 * instead made react-native-screens pop a fragment that was still mounting
 * ("Unable to find a fragment to pop"), which killed the process (#1126).
 *
 * Deliberately free of React and Bloom imports: `+native-intent` loads it
 * before the app tree exists.
 */
export const SETTINGS_PAGE_IDS = [
  "account",
  "about",
  "accessibility",
  "appearance",
  "connected-ai",
  "external-media",
  "fediverse",
  "fediverse/node",
  "feed",
  "for-you",
  "interests",
  "language",
  "live-presence",
  "notifications/subscriptions",
  "notifications",
  "privacy/blocked",
  "privacy/hidden-words",
  "privacy/hide-counts",
  "privacy/muted-lanes",
  "privacy/online-status",
  "privacy/profile-visibility",
  "privacy/restricted",
  "privacy/tags-mentions",
  "privacy",
  "thread-preferences",
] as const;
const pageIds: ReadonlySet<string> = new Set(SETTINGS_PAGE_IDS);
export function isSettingsPage(page: string): boolean {
  return pageIds.has(page);
}
export function settingsPageFromRoute(route: string): string | null {
  const pathname = route.split(/[?#]/)[0].replace(/\/$/, "");
  if (pathname === "/settings") return "account";
  if (!pathname.startsWith("/settings/")) return null;
  const id = pathname.slice("/settings/".length);
  return pageIds.has(id) ? id : null;
}

/** The page a request opens; `undefined` opens the navigation list. */
type SettingsRequestListener = (page: string | undefined) => void;
let listener: SettingsRequestListener | null = null;
let pending: { page: string | undefined } | null = null;

/**
 * Opens Settings at a `/settings[/page]` address. Returns false for any other
 * address so the caller can route it normally. A request made before the
 * provider mounts (a cold-start link) is held and delivered on mount.
 */
export function requestSettings(route: string): boolean {
  const page = settingsPageFromRoute(route);
  if (!page) return false;
  const target = page === "account" ? undefined : page;
  if (listener) listener(target);
  else pending = { page: target };
  return true;
}

/** The provider's side of `requestSettings`. One provider at a time. */
export function onSettingsRequest(next: SettingsRequestListener): () => void {
  listener = next;
  if (pending) {
    const { page } = pending;
    pending = null;
    next(page);
  }
  return () => {
    if (listener === next) listener = null;
  };
}
