import React from 'react';
import type { ProfileChromeFrameProps } from './types';

/**
 * The `[username]` layout's body — NATIVE, where it is only a passthrough.
 *
 * WEB renders the whole profile chrome here instead (`.web.tsx` beside this
 * file): the banner, the identity summary, the action cluster and the tab strip
 * all belong to the LAYOUT there, so switching tabs swaps only the routed
 * content beneath them. That is the fix this pair exists for — a strip rendered
 * inside each tab SCREEN is unmounted by the very navigation it performs, which
 * on web (every route is an async chunk) leaves the profile with no tab strip at
 * all for as long as the incoming tab's fetch takes: 597ms, measured on
 * production, before a skeleton and then the real bar snapping into place.
 *
 * NATIVE IS NOT ALREADY CORRECT — it has the same remount, and it is left alone
 * anyway. Two things to know before "unifying" these:
 *
 *  - The remount is INVISIBLE there, not absent. Native code is bundled, so the
 *    incoming tab has no chunk to fetch and the rebuild finishes inside a frame.
 *    The web symptom is the fetch, and only web has one.
 *  - The chrome CANNOT move up on native. On the post and grid tabs the feed's
 *    own virtualized list is the scroll container, and `ProfileShell` hands it
 *    the summary as `listHeaderComponent` and the strip as
 *    `listStickyHeaderComponent`, plus the scroll handler and ref the chrome
 *    animations read (`ProfileShell.tsx`, the `nativeListOwnsScroll` branch). A
 *    strip that is a route-owned list's sticky header cannot simultaneously be
 *    layout chrome, and moving that scroller — or routing its wiring through
 *    context across the route boundary — changes feed scroll behaviour, which is
 *    settled. Web has no such constraint: the DOCUMENT scrolls, and the chrome
 *    and the content are already siblings.
 *
 * So the split is real and deliberate. If native's scroll ownership ever
 * changes, this file is where the two meet again.
 *
 * A FRAGMENT, not a `<View>`: the children here are the segment's navigator, and
 * wrapping it in a box native did not have before would change every profile
 * sub-route's layout to buy nothing.
 */
export default function ProfileChromeFrame({ children }: ProfileChromeFrameProps) {
  return <>{children}</>;
}
