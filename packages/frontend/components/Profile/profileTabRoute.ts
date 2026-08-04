import type { Href } from 'expo-router';
import { TAB_NAMES, laneTabKey, type ProfileTab, type ProfileTabDescriptor } from './types';

/**
 * A profile tab's URL, and the reverse reading of one.
 *
 * Both directions live here because they are the SAME rule stated twice, and on
 * web they have two independent readers: the strip builds an `href` per tab, and
 * the layout that renders the strip has to answer which tab — if any — the
 * current pathname means. A disagreement between them underlines one tab while
 * paging another's feed, and nothing fails.
 */

/** The selection a profile URL names, as the strip and the chrome both read it. */
export interface ProfileTabSelection {
  /** The surface the tab renders. A lane tab renders `posts`. */
  tab: ProfileTab;
  /** Set on a LANE tab only. */
  laneId?: string;
  /** The descriptor key this selection matches (`posts`, `lane:<id>`, …). */
  key: string;
}

/** The segment a lane tab lives under, so a lane id can never shadow a tab file. */
const LANE_SEGMENT = 'lane';

/**
 * Where the strip sends one tab.
 *
 * `posts` collapses to the bare profile path: every link in the wild points at
 * `/@handle`, including the OG shell the backend serves, so it must BE the posts
 * tab rather than redirect to it.
 */
export function profileTabHref(handle: string, descriptor: ProfileTabDescriptor): Href {
  if (descriptor.laneId) return `/@${handle}/${LANE_SEGMENT}/${descriptor.laneId}`;
  return descriptor.tab === 'posts' ? `/@${handle}` : `/@${handle}/${descriptor.tab}`;
}

/**
 * Which tab a profile pathname is showing, or `null` when it is showing
 * something that is not a tab at all.
 *
 * `null` is the load-bearing half. The `[username]` layout serves the tabs AND
 * six full screens beside them — `/followers`, `/following`, `/about`,
 * `/connections`, `/in-common`, `/who-may-know` — each with its own header and
 * back arrow, and a banner and tab strip stacked above one would be a second,
 * contradictory chrome. So the layout draws chrome only where this answers with
 * a selection, and a child it has never heard of gets none rather than a guess.
 * That is why this is the exact INVERSE of `profileTabIndex`, which falls back
 * to the first tab: there an unknown key means "a lane that has not loaded yet",
 * here it means "not a tab".
 *
 * Read POSITIONALLY, from the segments after the handle, rather than by matching
 * the handle itself: a federated handle carries an `@` and a dot
 * (`/@ana@mastodon.social/replies`) and arrives percent-encoded often enough
 * that comparing it is a second way to be wrong. Only ASCII tab names are ever
 * compared. `(group)` segments never appear — expo-router's `usePathname()` has
 * already dropped them.
 *
 * The shapes are enumerated rather than prefix-matched, because every one of
 * them is a route file that exists: the bare handle is `index.tsx`, a named tab
 * is `<tab>.tsx`, and a lane is `lane/[laneId].tsx`. `posts` is deliberately not
 * accepted as a named segment — `profileTabHref` collapses it to the bare path,
 * so `/@ana/posts` is a URL nothing produces and no file serves.
 */
export function profileTabSelectionFromPathname(pathname: string): ProfileTabSelection | null {
  const segments = pathname.split('/').filter(Boolean);
  const [handleSegment, second, third] = segments;
  if (!handleSegment) return null;
  if (segments.length === 1) return { tab: 'posts', key: 'posts' };
  if (segments.length === 2) {
    return second !== 'posts' && (TAB_NAMES as readonly string[]).includes(second ?? '')
      ? { tab: second as ProfileTab, key: second as string }
      : null;
  }
  if (segments.length === 3 && second === LANE_SEGMENT && third) {
    return { tab: 'posts', laneId: third, key: laneTabKey(third) };
  }
  return null;
}
