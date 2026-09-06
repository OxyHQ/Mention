'use no memo';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InteractionManager, StyleSheet, View } from 'react-native';
import PagerView from 'react-native-pager-view';
import Animated, { useEvent, useHandler } from 'react-native-reanimated';
import { Screen } from 'react-native-screens';

import { TABS } from '@/components/navigation/tabs';

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
 */
export function TabsPager({ state, descriptors, progress, onCommit }: TabsPagerProps) {
  const pagerRef = useRef<PagerView>(null);
  /**
   * The page the PAGER believes it is on.
   *
   * The two directions — gesture→route and route→pager — both end up wanting to
   * move something, and without a record of who moved last they echo: a swipe
   * commits a route, the route change drives `setPage`, `setPage` fires
   * `onPageSelected`, which commits the route again. This ref is the arbiter,
   * and every write to it is paired with the action that made it true.
   */
  const pageRef = useRef(state.index);

  /**
   * Which routes may render their screen. A tab is admitted when it is focused,
   * and — for tabs that opted into it — when it becomes a NEIGHBOUR, so it is
   * not blank under the finger. `write` opts out (`TABS[].preload`): it is the
   * app's heaviest screen and mounting it merely for being swiped PAST would
   * spend exactly the cost this change removes.
   */
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(
    () => new Set([state.routes[state.index]?.key].filter(Boolean) as string[]),
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

  // Opt-out is read by route NAME, never by index. The navigator's route order
  // is built from `TABS` and does match it, but an index-keyed lookup would go
  // on silently answering the wrong question if that ever stopped being true —
  // and "the composer got preloaded after all" is not a symptom anybody would
  // trace back to here.
  const neighbourKeys = useCallback(
    (index: number) =>
      [index - 1, index + 1]
        .filter((i) => i >= 0 && i < state.routes.length)
        .filter((i) => TABS.find((tab) => tab.name === state.routes[i]?.name)?.preload !== false)
        .map((i) => state.routes[i]?.key),
    [state.routes],
  );

  const onPageScroll = usePageScrollHandler(
    (event) => {
      'worklet';
      // `position + offset` IS the unit Bloom's `activeProgress` is defined in:
      // 1.4 means 40% of the way from the second tab to the third. No mapping,
      // no scaling — that correspondence is why the two fit together at all.
      progress.value = event.position + event.offset;
    },
    [progress],
  );

  // ROUTE → PAGER. A tap on the bar, a deep link, a back gesture, a push
  // notification: anything that changes the focused tab without the finger.
  useEffect(() => {
    if (state.index === pageRef.current) return;
    pageRef.current = state.index;
    admit([state.routes[state.index]?.key]);
    pagerRef.current?.setPage(state.index);
  }, [state.index, state.routes, admit]);

  // Warm the neighbours of wherever we have settled — but only once the frame
  // budget is free. Mounting a feed is not something to do on the frame that
  // just finished a page transition; doing it now is what makes the SECOND
  // swipe in each direction instant.
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      admit(neighbourKeys(state.index));
    });
    return () => task.cancel();
  }, [state.index, admit, neighbourKeys]);

  const onPageScrollStateChanged = useCallback(
    (event: { nativeEvent: { pageScrollState: 'idle' | 'dragging' | 'settling' } }) => {
      if (event.nativeEvent.pageScrollState !== 'dragging') return;
      // The finger has started moving and either neighbour may come into view
      // within the frame. This one cannot wait for the interaction queue — that
      // is the blank page it exists to prevent.
      admit(neighbourKeys(pageRef.current));
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
      admit([state.routes[next]?.key]);
      onCommit(next);
    },
    [onCommit, admit, state.routes],
  );

  const pages = useMemo(
    () =>
      state.routes.map((route, index) => {
        const descriptor = descriptors[route.key];
        const isFocused = index === state.index;
        return (
          // `collapsable={false}` keeps the page a real view even when its
          // content is still null — a collapsed page would be dropped from the
          // native hierarchy and take its position with it.
          <View key={route.key} collapsable={false} style={styles.page}>
            {loaded.has(route.key) && descriptor ? (
              // `activityState` is what lets four mounted screens cost almost
              // nothing: 2 drives the focused one, 1 keeps a neighbour laid out
              // and painted so it is real under the finger, 0 parks the rest.
              // The app's global `enableFreeze(true)` acts on react-navigation
              // screens and never reaches inside a pager, so this is the only
              // thing standing between five live tabs and five live render
              // trees.
              <Screen
                enabled
                activityState={isFocused ? 2 : Math.abs(index - state.index) === 1 ? 1 : 0}
                style={styles.screen}
              >
                {descriptor.render()}
              </Screen>
            ) : null}
          </View>
        );
      }),
    [state.routes, state.index, descriptors, loaded],
  );

  return (
    <AnimatedPagerView
      ref={pagerRef}
      style={styles.pager}
      initialPage={state.index}
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
