import { Platform } from 'react-native';
import type { Href } from 'expo-router';

/**
 * The root PAGES of the mobile shell, in pager order — the single table.
 *
 * Before this, the same five destinations were spelled out three times over: a
 * ladder of `pathname === …` comparisons deriving the highlight's index, a
 * `switch` of `router.navigate` calls performing the navigation, and four
 * `TAB_*` index constants tying the two together. Nothing made them agree; they
 * agreed because somebody kept them in step.
 *
 * ONE TABLE, BUT TWO INDEX SPACES. Every page is a route of the tabs navigator
 * and a page of the pager. Only some of them also draw an item in the bottom
 * bar, and this file's earlier version said the opposite out loud — "Order IS
 * the tab index" — because at the time the two sets happened to be identical.
 * They are not the same question, and a page that the bar does not draw (the
 * camera, reached by swiping right off Home, exactly as Instagram does it) makes
 * the difference load-bearing: a PAGE index and a BAR index stop being the same
 * number, and every consumer has to say which one it means.
 *
 * So the conversions live here, once, and everything else calls them. Getting it
 * wrong does not fail loudly — it lands a tap on the neighbouring screen, or
 * parks the highlight one item to the right of the tab you are on.
 *
 * WHY THESE URLS. `/`, `/videos` and `/notifications` are unchanged — the
 * `(tabs)` group they live in adds no path segment. `/you` and `/write` each
 * exist because a tab route has to be STATIC while the thing it shows is not:
 * the viewer's own profile has no fixed handle (`/@<handle>` is a different URL
 * per person, and none at all when signed out), and the composer has to remain a
 * dismissible destination for the fourteen call sites that push it with a reply,
 * quote, edit or share intent. Both route files carry the full reasoning.
 */

/**
 * The route names, as a closed union. It is what lets a consumer keying a lookup
 * by name (the bar's glyphs) be checked for completeness instead of falling back
 * to `undefined` at runtime for a page somebody added here and nowhere else.
 */
export type PageName = 'camera' | 'index' | 'videos' | 'write' | 'notifications' | 'you';

/** What the bottom bar needs in order to draw a page as one of its items. */
export interface BarItemSpec {
  /** i18n key for the label under the glyph. */
  labelKey: string;
}

export interface PageDescriptor {
  /** Route name within the `(tabs)` group — the navigator's own identifier. */
  name: PageName;
  /** The page's exact path. */
  href: Href;
  /**
   * Whether this page may be mounted as a NEIGHBOUR, ahead of being visited.
   *
   * `false` for the composer alone today. Preloading a neighbour is what stops a
   * page being blank under the finger mid-swipe, and it is worth the mount for a
   * feed — but the composer is the app's heaviest screen and mounting it as a
   * side effect of swiping past it would trade the very cost the tabs rewrite
   * removes. It mounts when the reader actually lands on it.
   *
   * Required rather than optional on purpose: a page that forgets to answer
   * would be preloaded by default, and "it got mounted after all" is not a
   * symptom anybody traces back to a missing field.
   */
  preload: boolean;
  /**
   * Present when this page also draws an item in the bottom bar.
   *
   * Absent means "reachable, but not a bar item" — a page the reader swipes to
   * rather than taps. That is the whole reason PAGE and BAR are separate index
   * spaces.
   */
  bar?: BarItemSpec;
}

const PAGE_TABLE = [
  // The camera sits to the LEFT of Home and draws no bar item: it is reached by
  // swiping right off the feed and by the feed header's camera button, exactly
  // as Instagram does it. `preload: false` is not an optimization here — a
  // camera mounted for being a neighbour holds the sensor open behind the feed.
  { name: 'camera', href: '/camera', preload: false },
  { name: 'index', href: '/', preload: true, bar: { labelKey: 'bottomBar.home' } },
  { name: 'videos', href: '/videos', preload: true, bar: { labelKey: 'bottomBar.videos' } },
  { name: 'write', href: '/write', preload: false, bar: { labelKey: 'bottomBar.compose' } },
  {
    name: 'notifications',
    href: '/notifications',
    preload: true,
    bar: { labelKey: 'bottomBar.notifications' },
  },
  { name: 'you', href: '/you', preload: true, bar: { labelKey: 'bottomBar.profile' } },
] as const satisfies readonly PageDescriptor[];

export const PAGES: readonly PageDescriptor[] = PAGE_TABLE;

/**
 * The names of the pages that DRAW a bar item, as a closed union derived from
 * the table above rather than written out again.
 *
 * `as const satisfies` is what makes that possible: the annotation would erase
 * the literals, and a hand-written union would let the bar's glyph map claim
 * completeness while missing the page somebody just added — or, worse, demand a
 * glyph for the camera, which draws no item at all.
 */
export type BarTabName = Extract<(typeof PAGE_TABLE)[number], { bar: BarItemSpec }>['name'];

export type BarTabDescriptor = PageDescriptor & { name: BarTabName; bar: BarItemSpec };

/** The pages the bar draws, in bar order. Its length is the bar's item count. */
export const BAR_TABS: readonly BarTabDescriptor[] = PAGES.filter(
  (page): page is BarTabDescriptor => page.bar !== undefined,
);

/** Index of a page by route name within {@link PAGES}, or -1. */
export function pageIndexByName(name: string): number {
  return PAGES.findIndex((page) => page.name === name);
}

/** Index of a page by route name within {@link BAR_TABS}, or -1 when it draws none. */
export function barIndexByName(name: string): number {
  return BAR_TABS.findIndex((page) => page.name === name);
}

/** The bar item a page draws, or -1 when it draws none. */
export function pageToBar(pageIndex: number): number {
  const page = PAGES[pageIndex];
  return page ? barIndexByName(page.name) : -1;
}

/** The page a bar item lives on, or -1 when the bar index names none. */
export function barToPage(barIndex: number): number {
  const tab = BAR_TABS[barIndex];
  return tab ? pageIndexByName(tab.name) : -1;
}

/**
 * Where the bar's highlight belongs for each page, as bar units.
 *
 * A page the bar does not draw still has an answer here, and it is its nearest
 * drawn neighbour rather than a gap. That is what makes a swipe onto such a page
 * leave the capsule parked on the tab it came from instead of sliding it out of
 * the pill — Bloom copies `activeProgress` into its geometry raw and unclamped,
 * so an out-of-range value is a real place, one item-width outside the bar.
 * Hiding the whole bar over such a page is a separate decision, made by whoever
 * owns the chrome.
 */
/**
 * How fast the bar's highlight travels to a tab nobody dragged it to — a tap, a
 * deep link, a back gesture. Matched to Bloom's own `SLIDE_SPRING` by feel
 * rather than by import: Bloom does not export it, and the two are allowed to
 * differ (this one also has to look right against a page that is NOT sliding —
 * on web, and now on native, where a tap CUTS to its destination).
 *
 * It lives here rather than in `TabPagerContext` because both writers need it:
 * the provider springs the highlight when no pager is mounted, and the pager
 * springs it for the jump it does not animate.
 */
export const BAR_SETTLE_SPRING = { duration: 420, dampingRatio: 0.82 } as const;

export const BAR_POSITION_BY_PAGE: readonly number[] = PAGES.map((page, index) => {
  const own = barIndexByName(page.name);
  if (own !== -1) return own;
  for (let before = index - 1; before >= 0; before -= 1) {
    const nearer = barIndexByName(PAGES[before]!.name);
    if (nearer !== -1) return nearer;
  }
  for (let after = index + 1; after < PAGES.length; after += 1) {
    const nearer = barIndexByName(PAGES[after]!.name);
    if (nearer !== -1) return nearer;
  }
  return 0;
});

/**
 * 1 for a page the bar draws no item for, 0 for one it does.
 *
 * Fed through {@link barPositionForPage} exactly like the highlight's position,
 * so the bar fades out CONTINUOUSLY as the finger travels onto the camera and
 * back rather than popping when the page commits. Same interpolation, different
 * quantity — which is why that function takes its table as an argument.
 */
export const CHROME_HIDDEN_BY_PAGE: readonly number[] = PAGES.map((page) =>
  page.bar === undefined ? 1 : 0,
);

/**
 * A pager position in PAGE units — `position + offset`, so `1.4` is 40% of the
 * way from page 1 to page 2 — converted to the BAR units Bloom's `activeProgress`
 * is defined in.
 *
 * Interpolated between the two pages the finger is between rather than rounded,
 * because the whole point of that value is that the highlight tracks the finger
 * 1:1. Takes its table as an argument because there are two of them —
 * `BAR_POSITION_BY_PAGE` for where the highlight sits and
 * `CHROME_HIDDEN_BY_PAGE` for whether the bar is there at all — and because a
 * test can then exercise a page set production does not have.
 *
 * A worklet as well as a plain function: the pager writes this from the UI
 * thread inside `onPageScroll`, and a second copy of four lines of arithmetic is
 * exactly the kind of duplicate that drifts.
 */
export function barPositionForPage(
  barPositionByPage: readonly number[],
  pagePosition: number,
): number {
  'worklet';
  const last = barPositionByPage.length - 1;
  if (last < 0) return 0;
  if (pagePosition <= 0) return barPositionByPage[0]!;
  if (pagePosition >= last) return barPositionByPage[last]!;
  const from = Math.floor(pagePosition);
  const fraction = pagePosition - from;
  const start = barPositionByPage[from]!;
  const end = barPositionByPage[from + 1]!;
  return start + (end - start) * fraction;
}

/**
 * Where a page actually SENDS the reader, which is not always its route.
 *
 * One page differs, and only on one platform. `/you` exists because a tab route
 * has to be static while the viewer's own handle is not — but WEB has no tab
 * navigator at all (`(tabs)/_layout.tsx` renders a bare `<Slot/>`), so nothing
 * there needs a static route, and the profile page's chrome lives in the
 * `[username]` layout where a `/you` screen cannot reach it. So on web the
 * profile tab points where the sidebar has always pointed: `/@<handle>`.
 *
 * Signed out on web it stays `/you`, which renders the sign-in prompt — the one
 * thing that route does well on both platforms.
 *
 * This is THE definition, and `pageIndexForPathname` below answers "which page is
 * this route" by asking it rather than by repeating the rule. Before, the bar
 * pointed at `/you` on web and that route redirected to `/@<handle>`; chaining a
 * redirect onto a tab press is what stopped the profile tab opening at all.
 */
export function tabHref(page: PageDescriptor, viewerUsername?: string): Href {
  // Read here rather than hoisted to a module constant: this is the one rule in
  // the file that differs by platform, and a test can only exercise both sides of
  // it if the read happens per call.
  if (page.name === 'you' && Platform.OS === 'web' && viewerUsername) {
    return `/@${viewerUsername}`;
  }
  return page.href;
}

/**
 * Which PAGE a pathname is, or -1 when it is none of them.
 *
 * -1 is a real answer and the common one: every pushed detail route — a post, a
 * settings page, somebody else's profile — is not a root page, and the bar
 * renders over all of them.
 *
 * It compares against {@link tabHref}, so it agrees with where the bar sends the
 * reader by construction. On web that means the viewer's own `/@<handle>` IS the
 * profile tab; on native it is an ordinary pushed route — a copy of your own
 * profile opened from a post row — and correctly selects nothing.
 */
export function pageIndexForPathname(
  pathname: string | null | undefined,
  viewerUsername?: string,
): number {
  if (!pathname) return -1;
  return PAGES.findIndex((page) => tabHref(page, viewerUsername) === pathname);
}

/**
 * Which BAR ITEM a pathname selects, or -1 for none.
 *
 * Bloom reads exactly this convention on `activeIndex`, fading the highlight out
 * where it stands rather than parking it outside the pill. Note that -1 here
 * means "the bar draws nothing for this route", which is NOT the same as "the
 * reader is off the root pages": a page the bar does not draw answers -1 too.
 * Anything that means the second one has to ask {@link pageIndexForPathname}.
 */
export function barIndexForPathname(
  pathname: string | null | undefined,
  viewerUsername?: string,
): number {
  return pageToBar(pageIndexForPathname(pathname, viewerUsername));
}
