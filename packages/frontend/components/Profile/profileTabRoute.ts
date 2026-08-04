import type { Href } from 'expo-router';
import { TAB_NAMES, laneTabKey, type ProfileTab, type ProfileTabDescriptor } from './types';

/**
 * A profile tab's URL, and the reverse reading of one.
 *
 * Both directions live here because they are the SAME rule stated twice, and on
 * web they now have two independent readers: the strip builds an `href` per tab,
 * and the layout that renders the strip has to answer which tab the current
 * pathname means (it owns the scroll pager, which pages the ACTIVE tab's feed —
 * see `useProfileScroll`). A disagreement between them pages one feed while
 * underlining another, and nothing fails.
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
 * Which tab a profile pathname is showing.
 *
 * Read POSITIONALLY, from the segments after the handle, rather than by matching
 * the handle itself: a federated handle carries an `@` and a dot
 * (`/@ana@mastodon.social/replies`) and arrives percent-encoded often enough
 * that comparing it is a second way to be wrong. `(group)` segments never appear
 * — expo-router's `usePathname()` has already dropped them — so the tab is
 * always the second segment.
 *
 * An unrecognised segment reads as `posts`, matching `profileTabIndex`'s
 * fallback: this runs on every route under the tab group, including one added
 * later without a strip entry, and a tab strip is not the place to throw.
 */
export function profileTabFromPathname(pathname: string): ProfileTabSelection {
  const segments = pathname.split('/').filter(Boolean);
  const [, second, third] = segments;
  if (second === LANE_SEGMENT && third) {
    return { tab: 'posts', laneId: third, key: laneTabKey(third) };
  }
  const named = (TAB_NAMES as readonly string[]).includes(second ?? '')
    ? (second as ProfileTab)
    : 'posts';
  return { tab: named, key: named };
}
