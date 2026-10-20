/**
 * Routes that are full-screen, not a page under the app's bar.
 *
 * The pushed composer (`/compose`: a reply, quote, edit or share) is a stack screen above the tabs, so no pager page describes it and
 * `CHROME_HIDDEN_BY_PAGE` never hid the bar for it: the tab bar and the compose
 * FAB sat on the reply composer's own footer (#1140). `/write`, the composer
 * TAB, is not listed: it is a pager page, and the bar fades out over it with
 * the swipe.
 */
const FULL_SCREEN_ROUTES = ['/compose'] as const;

export function hidesBottomBar(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return FULL_SCREEN_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/** Which bottom control is visible: shell navigation or the main panel's invitation. */
export type BottomBarContent = 'tabs' | 'sign-in' | null;

/**
 * The bottom edge: the tab bar for a signed-in reader, the sign-in invitation
 * for an anonymous one, and nothing on a full-screen route or over the
 * keyboard. The invitation is owned by the main panel's Screen: its pinned
 * bar reserves its measured height at the end of the column, so nothing it
 * covers is lost and nothing loading above it moves it. Rendered inline after
 * the route instead, every change in the page's height pushed it down the
 * viewport and out of it (#1216 measured it as half the profile's layout
 * shift). Only once auth is resolved: during cold-boot restore
 * `isAuthenticated` is undetermined and would flash the invitation to a reader
 * whose session is about to restore.
 */
export function bottomBarContent({
  pathname,
  keyboardVisible,
  isAuthenticated,
  isAuthResolved,
}: {
  pathname: string | null | undefined;
  keyboardVisible: boolean;
  isAuthenticated: boolean;
  isAuthResolved: boolean;
}): BottomBarContent {
  if (keyboardVisible || hidesBottomBar(pathname)) return null;
  if (isAuthenticated) return 'tabs';
  return isAuthResolved ? 'sign-in' : null;
}
