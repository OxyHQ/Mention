import React from 'react';
import { Slot } from 'expo-router';

import type { TabsPagerProps } from './TabsPager.types';

/**
 * WEB — there is no pager, and there deliberately is not going to be one here.
 *
 * Paging screens side by side means every page is viewport-height and clipped
 * inside a horizontally-scrolling box. This app's web scroll model is the exact
 * opposite and load-bearing throughout: the BODY is the scroller
 * (`app/(app)/_layout.tsx`), `components/Feed/Feed.web.tsx` is a WINDOW
 * virtualizer measuring against the document, `stores/feedScrollStore.ts` and
 * Bloom's `useScrollRestoration('window')` persist `window.scrollY`, and
 * `components/shell/PanelChrome.tsx` pins its chrome with `position: sticky`.
 * There is no arrangement of five side-by-side pages that leaves those true.
 * Bloom's own `docs/scroll.mdx` records the same wall from the other side: a
 * tabbed navigator hides blurred tabs with `display: none`, which collapses the
 * document and clamps `scrollY` to 0.
 *
 * What web gets instead is the half that was actually broken: the highlight now
 * moves when the reader ACTS rather than when the route chunk lands (measured at
 * 597ms for one such chunk — `components/Profile/ProfileChromeFrame.web.tsx`).
 * That is `TabPagerContext`'s optimistic write, and it needs no pager.
 *
 * This file existing at all is what keeps `react-native-pager-view` — which
 * ships no web implementation — out of the web graph, and therefore out of the
 * CI-enforced initial-JS budget.
 */
export function TabsPager(_props: TabsPagerProps) {
  return <Slot />;
}
