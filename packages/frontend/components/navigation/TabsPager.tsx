'use no memo';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import PagerView from 'react-native-pager-view';
import Animated, { useEvent, useHandler, withSpring } from 'react-native-reanimated';
import { Screen } from 'react-native-screens';

import {
  BAR_POSITION_BY_PAGE,
  BAR_SETTLE_SPRING,
  CHROME_HIDDEN_BY_PAGE,
  PAGES,
  barPositionForPage,
  pageIndexByName,
} from '@/components/navigation/tabs';

import type { TabsPagerProps } from './TabsPager.types';

const AnimatedPagerView = Animated.createAnimatedComponent(PagerView);

/**
 * `onPageScroll` on the UI thread.
 *
 * `PagerView`'s scroll event is a DIRECT event, so reanimated can subscribe to
 * it by name and run the worklet in the UI runtime — no bridge hop, no JS frame
 * between the finger and the highlight. That is the whole reason this is a
 * `PagerView` and not `@react-navigation/material-top-tabs`, whose `position` is
 * an RN `Animated` value that would have to be read back through a per-frame JS
 * listener on the very thread this change exists to unblock.
 */
type PageScrollEvent = { position: number; offset: number };

/** What `PagerView` declares `onPageScroll` to be, via its codegen'd native props. */
type PagerScrollProp = React.ComponentProps<typeof PagerView>['onPageScroll'];

function usePageScrollHandler(
  handler: (event: PageScrollEvent) => void,
  deps: unknown[],
): PagerScrollProp {
  const { doDependenciesDiffer } = useHandler({ onPageScroll: handler }, deps);
  const processed = useEvent<PageScrollEvent>(
    (event) => {
      'worklet';
      handler(event);
    },
    ['onPageScroll'],
    doDependenciesDiffer,
  );
  // Reanimated hands back an `EventHandlerProcessed`, which is what actually
  // gets attached to the native view; `PagerView`'s prop is typed as the
  // codegen `DirectEventHandler` it would have been given by React. The two
  // describe the same attachment from opposite ends and TypeScript cannot see
  // that, so the cast is the seam — and it is confined to this one line rather
  // than loosening the prop or the handler.
  return processed as unknown as PagerScrollProp;
}

/**
 * The five tab screens, side by side, paged by the platform's own pager.
 *
 * WHY `react-native-pager-view` AND NOT A HAND-ROLLED REANIMATED PAGER. The two
 * hard parts of paging are not the translation — they are deciding, mid-touch,
 * whether a drag belongs to this pager or to a child that also scrolls, and
 * handing the gesture back cleanly when it does not. Every tab here has such a
 * child: two virtualized feeds, and `/videos`, which is a full-screen
 * VERTICALLY paged list. `PagerView` is ViewPager2 on Android and
 * `UIPageViewController` on iOS — the platform components whose entire job is
 * that arbitration, and the ones `react-native-tab-view` itself reaches for.
 * Re-deriving it in JS is the "tricky thing" this rewrite is meant to remove.
 *
 * PAGES ARE POSITIONAL. `PagerView` addresses its children by index, so a lazy
 * page must render an empty `<View>` and never `null` — returning nothing would
 * shift every page after it and land a swipe on the wrong screen. The laziness
 * is therefore INSIDE each page, not in the child list.
 *
 * A PAGE INDEX IS A `PAGES` INDEX, AND THE NAVIGATOR'S IS NOT. `state.routes`
 * arrives in expo-router's own order: `triggersToScreens` sorts the triggers it
 * is handed with `sortRoutesWithInitial`, which puts `index` first and then
 * sorts by route-name LENGTH. The five pages therefore come back as
 * index/you/write/videos/notifications, not the order this file's `PAGES`
 * declares. `selectTab` and `commit` index `PAGES`, so the pages are built from
 * `PAGES` and every route is reached BY NAME. Ordering by `state.routes` would
 * put the profile where the bar draws Videos.
 *
 * A PAGE INDEX IS NOT A BAR INDEX EITHER, and that is the other conversion this
 * file owns. `progress` is in the BAR units Bloom's `activeProgress` is defined
 * in, and only some pages draw a bar item — so `onPageScroll` converts before
 * it writes. Bloom copies that value into its geometry raw and unclamped, so a
 * page position arriving in a bar-units slot does not fail: it silently parks
 * the capsule one item away from the tab you are on.
 */
export function TabsPager({
  state,
  descriptors,
  progress,
  chromeProgress,
  onCommit,
}: TabsPagerProps) {
  const pagerRef = useRef<PagerView>(null);

  /** The navigator's routes, reachable by the name a `TABS` entry declares. */
  const routeByName = useMemo(
    () => new Map(state.routes.map((route) => [route.name, route])),
    [state.routes],
  );

  /**
   * The focused tab as a PAGE index.
   *
   * -1 would mean the navigator focused a route no tab names, which the layout's
   * dev check reports; page 0 is the honest fallback rather than an index
   * `PagerView` would reject.
   */
  const focusedPage = Math.max(0, pageIndexByName(state.routes[state.index]?.name ?? ''));

  /**
   * The page the PAGER believes it is on.
   *
   * The two directions — gesture→route and route→pager — both end up wanting to
   * move something, and without a record of who moved last they echo: a swipe
   * commits a route, the route change drives `setPage`, `setPage` fires
   * `onPageSelected`, which commits the route again. This ref is the arbiter,
   * and every write to it is paired with the action that made it true.
   */
  const pageRef = useRef(focusedPage);

  /**
   * Which routes may render their screen. A tab is admitted when it is focused,
   * and — for pages that opted into it — when it becomes a NEIGHBOUR, so it is
   * not blank under the finger. `write` opts out (`PAGES[].preload`): it is the
   * app's heaviest screen and mounting it merely for being swiped PAST would
   * spend exactly the cost this change removes.
   */
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(
    () => new Set([state.routes[state.index]?.key].filter(Boolean) as string[]),
  );

  /**
   * The page the LIVE BAND is measured from: where the pager has come to REST,
   * which lags `focusedPage` for the length of a transition.
   *
   * A tap moves `focusedPage` in the commit it produces, and the destination has
   * to be live in that same commit — it is what the reader is now looking at.
   * Its NEIGHBOURS do not: nothing can reach them until the pager stops moving,
   * and each one costs a whole screen's render plus its native views to bring
   * back (see the `activityState` note below for why that is not free). So the
   * band moves when the pager says it has settled, off the frame that is already
   * paying for the destination.
   */
  const [settledPage, setSettledPage] = useState(focusedPage);

  /** The key of the route a page shows, or undefined for a tab with no route. */
  const keyForPage = useCallback(
    (page: number) => routeByName.get(PAGES[page]?.name ?? '')?.key,
    [routeByName],
  );

  const admit = useCallback((keys: (string | undefined)[]) => {
    setLoaded((current) => {
      let next: Set<string> | null = null;
      for (const key of keys) {
        if (!key || current.has(key)) continue;
        next ??= new Set(current);
        next.add(key);
      }
      return next ?? current;
    });
  }, []);

  // Both the neighbour and its opt-out are read off `PAGES`, because a NEIGHBOUR
  // is a PAGE question: the two screens a swipe can reach from here. The
  // navigator's own order would name two different screens and preload the wrong
  // pair — including the composer, the one screen that opted out.
  //
  // The opt-in test is `=== true`, not `!== false`: a page the table has never
  // heard of answers `undefined`, and under the old spelling that counted as
  // opting IN. A page nobody declared is precisely the one not to mount for
  // being swiped past.
  const neighbourKeys = useCallback(
    (page: number) =>
      [page - 1, page + 1]
        .filter((i) => i >= 0 && i < PAGES.length)
        .filter((i) => PAGES[i]?.preload === true)
        .map((i) => keyForPage(i)),
    [keyForPage],
  );

  const onPageScroll = usePageScrollHandler(
    (event) => {
      'worklet';
      // `position + offset` is a PAGE position — 1.4 is 40% of the way from page
      // 1 to page 2 — and `progress` is in BAR units. They are the same number
      // only while every page draws a bar item, which is a fact about today's
      // table rather than a property of either.
      const page = event.position + event.offset;
      progress.value = barPositionForPage(BAR_POSITION_BY_PAGE, page);
      // Same frame, same interpolation, different quantity: the bar fades out as
      // the finger travels onto a page it draws no item for. Continuous, because
      // a bar that vanished on commit would announce the commit rather than
      // follow the finger.
      chromeProgress.value = barPositionForPage(CHROME_HIDDEN_BY_PAGE, page);
    },
    [progress, chromeProgress],
  );

  // ROUTE → PAGER. A tap on the bar, a deep link, a back gesture, a push
  // notification: anything that changes the focused tab without the finger.
  //
  // IT CUTS, IT DOES NOT TRAVEL. `setPage` is `ViewPager2.setCurrentItem(i,
  // true)`, an animated scroll THROUGH every page in between — measured at ~680ms
  // per tap on a Pixel 10 Pro, spent sliding across pages that are frozen and
  // therefore blank. A tap names a destination, not a journey, and every app the
  // reader compares this one to arrives immediately.
  //
  // The highlight is what still travels, and it has to be sprung from here: with
  // no scroll there is no `onPageScroll`, and the single event a jump does emit
  // would teleport the capsule. `chromeProgress` follows the same rule for the
  // same reason — the bar must fade out over a page that draws no item for it
  // whether the finger or a tap put us there.
  useEffect(() => {
    if (focusedPage === pageRef.current) return;
    pageRef.current = focusedPage;
    admit([keyForPage(focusedPage)]);
    pagerRef.current?.setPageWithoutAnimation(focusedPage);
    progress.value = withSpring(
      barPositionForPage(BAR_POSITION_BY_PAGE, focusedPage),
      BAR_SETTLE_SPRING,
    );
    chromeProgress.value = withSpring(
      barPositionForPage(CHROME_HIDDEN_BY_PAGE, focusedPage),
      BAR_SETTLE_SPRING,
    );
  }, [focusedPage, keyForPage, admit, progress, chromeProgress]);

  // Warm the neighbours of wherever the band has come to rest, on the frame
  // AFTER the one that put it there. Mounting a feed is not something to do on a
  // frame that is already rendering a screen — at mount that frame is the app's
  // first paint, and after a settle it is the one that thawed the destination.
  // It is what makes the SECOND swipe in each direction instant.
  //
  // `requestAnimationFrame` rather than `InteractionManager.runAfterInteractions`,
  // which this waited on and which waits for nothing: in react-native 0.86 that
  // module is a deprecation stub whose `runAfterInteractions` is a bare
  // `setImmediate` and whose `createInteractionHandle` returns -1 and does
  // nothing (`Libraries/Interaction/InteractionManager.js`). It ran inside the
  // commit's own batch. The real "wait for the transition" signal is the pager's
  // settle, and `settledPage` is now it.
  useEffect(() => {
    const frame = requestAnimationFrame(() => admit(neighbourKeys(settledPage)));
    return () => cancelAnimationFrame(frame);
  }, [settledPage, admit, neighbourKeys]);

  const onPageScrollStateChanged = useCallback(
    (event: { nativeEvent: { pageScrollState: 'idle' | 'dragging' | 'settling' } }) => {
      const scrollState = event.nativeEvent.pageScrollState;
      // `settling` is the one state that must change nothing: the pager is in
      // flight, and that is precisely when the band may not move.
      if (scrollState === 'settling') return;
      if (scrollState === 'dragging') {
        // The finger has started moving and either neighbour may come into view
        // within the frame. This one cannot wait for the effect above — that is
        // the blank page it exists to prevent.
        admit(neighbourKeys(pageRef.current));
      }
      // Both remaining states say the same thing about the band: no transition
      // is running for its cost to land in the middle of. `idle` is one that has
      // finished; `dragging` is one the finger has taken over, and a page under
      // a finger has to be real whatever it costs.
      setSettledPage(pageRef.current);
    },
    [admit, neighbourKeys],
  );

  // PAGER → ROUTE. Fires for a released swipe AND for a `setPage` we ourselves
  // performed; the ref guard is what makes the second one a no-op rather than a
  // second commit of a route that is already current.
  const onPageSelected = useCallback(
    (event: { nativeEvent: { position: number } }) => {
      const next = event.nativeEvent.position;
      if (next === pageRef.current) return;
      pageRef.current = next;
      admit([keyForPage(next)]);
      // A page index IS a `PAGES` index, which is the unit `selectTab` takes.
      onCommit(next);
    },
    [onCommit, admit, keyForPage],
  );

  const pages = useMemo(
    () =>
      PAGES.map((page, index) => {
        const route = routeByName.get(page.name);
        const descriptor = route ? descriptors[route.key] : undefined;
        const isFocused = index === focusedPage;
        return (
          // `collapsable={false}` keeps the page a real view even when its
          // content is still null — a collapsed page would be dropped from the
          // native hierarchy and take its position with it.
          <View key={page.name} collapsable={false} style={styles.page}>
            {route && loaded.has(route.key) && descriptor ? (
              // `activityState` is what lets four mounted screens cost almost
              // nothing: 2 drives the focused one, 1 keeps a page in the live
              // band laid out and painted so it is real under the finger, 0
              // parks the rest.
              //
              // 0 IS NOT A CHEAP STATE TO LEAVE, which is why the band follows
              // `settledPage`. `app/_layout.tsx` calls `enableFreeze(true)`, and
              // `Screen` reads that global as the default for its own
              // `freezeOnBlur` — so a page at 0 here is genuinely suspended by
              // react-freeze, and coming back off 0 re-renders its whole tree
              // and re-mounts its native views. Measured from `focusedPage` the
              // band moved in the same commit as the tap, so every tap two or
              // more pages away thawed TWO screens at once: the destination, and
              // whichever page had just become the destination's neighbour.
              // Tapping Home from the profile thawed the feed AND the reels
              // screen on the one frame the reader was waiting on.
              //
              // EVERY PAGE THE BAR CAN REACH STAYS LAID OUT, and the band no
              // longer decides that. The band is a locality rule — it assumes
              // the reader ARRIVES at a page by travelling past its neighbours —
              // and a tap stopped travelling: it cuts straight to its
              // destination. So "next to the current page" says nothing about
              // what the reader is one gesture away from, while the bar says it
              // exactly: any of its items, always.
              //
              // What that buys is the whole of the remaining wait. A page at 0
              // is react-freeze suspended, and coming off 0 re-renders its tree
              // and re-mounts its native views on the frame the reader is
              // watching — a virtualized feed of posts, a reel, a notification
              // list. Held at 1 they are laid out and painted, and the cut is
              // all that is left.
              //
              // The composer is the exception, and it declares itself: it is a
              // bar item with `preload: false`, already opted out of being
              // mounted as a neighbour because it is the app's heaviest screen.
              // The same flag answers this question, so there is one place that
              // says "not this one". The camera is not a bar item at all — it is
              // reached by a deliberate swipe — and stays on the band.
              <Screen
                enabled
                activityState={
                  isFocused ? 2 : (page.bar && page.preload) || Math.abs(index - settledPage) <= 1 ? 1 : 0
                }
                style={styles.screen}
              >
                {descriptor.render()}
              </Screen>
            ) : null}
          </View>
        );
      }),
    [routeByName, focusedPage, settledPage, descriptors, loaded],
  );

  return (
    <AnimatedPagerView
      ref={pagerRef}
      style={styles.pager}
      initialPage={focusedPage}
      // One page either side is exactly what the neighbour admission above
      // maintains; more would ask the platform to keep screens alive that have
      // no content to show.
      offscreenPageLimit={1}
      // No rubber-band at the ends. An overdrag on the first or last tab is a
      // horizontal gesture the pager consumes and then does nothing with —
      // stolen from whatever child wanted it.
      overdrag={false}
      onPageScroll={onPageScroll}
      onPageSelected={onPageSelected}
      onPageScrollStateChanged={onPageScrollStateChanged}
    >
      {pages}
    </AnimatedPagerView>
  );
}

const styles = StyleSheet.create({
  pager: { flex: 1 },
  page: { flex: 1 },
  screen: { flex: 1 },
});
