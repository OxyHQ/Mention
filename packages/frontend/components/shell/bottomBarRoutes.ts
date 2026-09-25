/**
 * Routes that are a full-screen conversation, not a page under the app's bar.
 *
 * The Alia chat (`app/(app)/ai`) owns the whole screen down to its own text
 * input, which sits at the bottom edge exactly where the shell draws the bottom
 * tab bar and its compose FAB. With the bar drawn, the input was covered by
 * both (#1140). A chat is a place you leave with Back, the way a messaging app
 * hides its tabs inside a conversation, so the shell draws no bar there.
 *
 * The pushed composer (`/compose`: a reply, quote, edit or share) is the same
 * case. It is a stack screen above the tabs, so no pager page describes it and
 * `CHROME_HIDDEN_BY_PAGE` never hid the bar for it: the tab bar and the compose
 * FAB sat on the reply composer's own footer (#1140). `/write`, the composer
 * TAB, is not listed: it is a pager page, and the bar fades out over it with
 * the swipe.
 */
const FULL_SCREEN_ROUTES = ['/ai', '/compose'] as const;

export function hidesBottomBar(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return FULL_SCREEN_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}
