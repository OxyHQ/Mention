import type { Href } from 'expo-router';

/**
 * The five root destinations, in bar order — the single table.
 *
 * Before this, the same five were spelled out three times over: a ladder of
 * `pathname === …` comparisons deriving the highlight's index, a `switch` of
 * `router.navigate` calls performing the navigation, and four `TAB_*` index
 * constants tying the two together (`components/BottomBar.tsx`). Nothing made
 * them agree; they agreed because somebody kept them in step.
 *
 * Now the bar's items, the navigator's triggers and the "which tab is this
 * route" question all read this, so a tab is added or reordered in one place.
 * Order IS the tab index: it decides the pager's page order, the highlight's
 * position and which two tabs are neighbours under a swipe.
 *
 * WHY THESE FIVE URLS. `/`, `/videos` and `/notifications` are unchanged — the
 * `(tabs)` group they now live in adds no path segment. `/you` and `/write` are
 * new, and each exists because a tab route has to be STATIC while the thing it
 * shows is not: the viewer's own profile has no fixed handle (`/@<handle>` is a
 * different URL per person, and none at all when signed out), and the composer
 * has to remain a dismissible destination for the fourteen call sites that push
 * it with a reply, quote, edit or share intent. Both route files carry the full
 * reasoning.
 */
/**
 * The route names, as a closed union. It is what lets a consumer keying a lookup
 * by tab name (the bar's glyphs) be checked for completeness instead of falling
 * back to `undefined` at runtime for a tab somebody added here and nowhere else.
 */
export type TabName = 'index' | 'videos' | 'write' | 'notifications' | 'you';

export interface TabDescriptor {
  /** Route name within the `(tabs)` group — the navigator's own identifier. */
  name: TabName;
  /** The tab's exact path. */
  href: Href;
  /** i18n key for the label under the glyph. */
  labelKey: string;
  /**
   * Whether this tab may be mounted as a NEIGHBOUR, ahead of being visited.
   *
   * `false` for the composer alone. Preloading a neighbour is what stops a page
   * being blank under the finger mid-swipe, and it is worth the mount for a
   * feed — but the composer is the app's heaviest screen and mounting it as a
   * side effect of swiping past it would trade the very cost this change
   * removes. It mounts when the reader actually lands on it.
   */
  preload: boolean;
}

export const TABS: readonly TabDescriptor[] = [
  { name: 'index', href: '/', labelKey: 'bottomBar.home', preload: true },
  { name: 'videos', href: '/videos', labelKey: 'bottomBar.videos', preload: true },
  { name: 'write', href: '/write', labelKey: 'bottomBar.compose', preload: false },
  {
    name: 'notifications',
    href: '/notifications',
    labelKey: 'bottomBar.notifications',
    preload: true,
  },
  { name: 'you', href: '/you', labelKey: 'bottomBar.profile', preload: true },
] as const;

/** Index of a tab by route name, or -1. */
export function tabIndexByName(name: string): number {
  return TABS.findIndex((tab) => tab.name === name);
}

/**
 * Which tab a pathname belongs to, or -1 when it belongs to none.
 *
 * -1 is a real answer and the common one: every pushed detail route — a post, a
 * settings page, somebody else's profile — is not a tab, and the bar renders
 * over all of them. Bloom's `TabBar` reads exactly this convention, fading the
 * highlight out where it stands rather than parking it outside the pill.
 *
 * `/@<handle>` counts as the profile tab only for the VIEWER's own handle. On
 * web `/you` redirects there (the profile chrome lives in the `[username]`
 * layout, so there is no chrome for a `/you` screen to render under), and
 * without this the bar would show no selection on a viewer's own profile page.
 * Somebody else's `/@<handle>` is a pushed route and correctly selects nothing.
 */
export function tabIndexForPathname(
  pathname: string | null | undefined,
  viewerUsername?: string,
): number {
  if (!pathname) return -1;
  const exact = TABS.findIndex((tab) => tab.href === pathname);
  if (exact !== -1) return exact;
  if (viewerUsername && pathname === `/@${viewerUsername}`) {
    return tabIndexByName('you');
  }
  return -1;
}
