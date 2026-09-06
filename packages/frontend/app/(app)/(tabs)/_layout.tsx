import React, { useCallback, useEffect, useMemo } from 'react';
import { Platform } from 'react-native';
import { Slot } from 'expo-router';
import { useTabsWithTriggers } from 'expo-router/ui';

import { TabsPager } from '@/components/navigation/TabsPager';
import { TABS } from '@/components/navigation/tabs';
import { useTabPager } from '@/context/TabPagerContext';

const IS_WEB = Platform.OS === 'web';

/**
 * The five root destinations of the mobile bottom bar, as one navigator.
 *
 * WHY A GROUP AND NOT A DIRECTORY: `(tabs)` adds no path segment, so `/`,
 * `/videos` and `/notifications` are exactly the URLs they were. Every existing
 * link, deep link, push-notification target and the sidebar's own route table
 * keep working untouched, which is what made this safe to land at all.
 *
 * WHAT IT IS FOR: until now these five were ordinary siblings of every other
 * route in one `ExperimentalStack`, so switching tab MOUNTED a screen from
 * scratch — no preserved scroll, no preserved state, and the JS thread blocked
 * for as long as the incoming screen took to render (`videos.tsx` is 2270 lines
 * of `expo-video` players). Here they are alive side by side and the pager
 * simply moves between them.
 *
 * A PRECEDENT THIS FILE HAS TO ANSWER: grouping tab routes under a nested
 * segment shipped once and was reverted —
 * `components/Profile/ProfileChromeFrame.web.tsx` carries the trace. A pushed
 * `[username]` entry carried no nested navigation state, so its child navigator
 * had to choose an initial route and settled on `about`, which expo-router then
 * wrote into the URL; `unstable_settings`' anchor had no effect on it. This case
 * is materially different — every tab here has its own distinct URL, so no
 * navigation ever resolves to "the group" without naming a child — but that file
 * records a 3/3 local reproduction of a thing that looked safe, so the deep-link
 * check is on the manual list rather than assumed.
 *
 * WEB RENDERS A PLAIN `<Slot/>`, and that is not a stopgap: the whole web shell
 * is a DOCUMENT-scroll model that side-by-side pages cannot coexist with.
 * `components/navigation/TabsPager.web.tsx` carries the full account, and the
 * part of the complaint that was web's — the highlight arriving after the route
 * chunk — is fixed there by `TabPagerContext`, with no navigator involved.
 *
 * The branch is STATIC per platform, the same shape `app/(app)/_layout.tsx`
 * already uses for its own `<Slot/>`-vs-stack split. That matters: a `<Slot/>`
 * appearing at two different tree positions is what produced React error #185
 * in the profile layout, and a branch that cannot change at runtime cannot do
 * that.
 */
export default function TabsLayout() {
  if (IS_WEB) {
    return <Slot />;
  }
  return <NativeTabsLayout />;
}

function NativeTabsLayout() {
  const { progress, selectTab, registerCommitter } = useTabPager();

  const triggers = useMemo(
    () => TABS.map((tab) => ({ type: 'internal' as const, name: tab.name, href: tab.href })),
    [],
  );

  const { state, descriptors, navigation, NavigationContent } = useTabsWithTriggers({
    triggers,
    // Back retraces the tabs the reader actually visited, rather than always
    // returning to home — the behaviour of every tabbed app they already use.
    backBehavior: 'history',
  });

  /**
   * Switch tab without a route push.
   *
   * `navigation.navigate(name)` is the tab router's own move, so it neither
   * stacks a history entry per swipe nor unmounts the tab being left. A
   * `router.navigate(href)` would reach the same screen and lose both
   * properties.
   */
  const commit = useCallback(
    (index: number) => {
      const tab = TABS[index];
      if (!tab) return;
      navigation.navigate(tab.name);
    },
    [navigation],
  );

  // Hand the bar — which lives above this layout, because it renders over pushed
  // routes too — the two things only the navigator can do: commit a tab, and
  // own the highlight's position while the pager is writing it every frame.
  useEffect(() => {
    registerCommitter({ commit, drivesProgress: true });
    return () => registerCommitter(null);
  }, [commit, registerCommitter]);

  /**
   * Every tab must have a route to show, and this says so out loud in dev.
   *
   * NOT the same claim as "the orders match", which they do not: expo-router
   * sorts the triggers it is handed (`sortRoutesWithInitial` — `index` first,
   * then by route-name length), so the navigator's order is its own and
   * `TabsPager` maps to it BY NAME. What would still break the bar is a tab
   * naming a route the navigator never built: its page would render empty while
   * the highlight sat over it, and a swipe would land on nothing.
   * `components/navigation/__tests__/tabRouteTargets.test.ts` pins the file-tree
   * half statically; this catches a trigger the router dropped at runtime.
   */
  if (__DEV__) {
    const missing = TABS.filter((tab) => !state.routes.some((route) => route.name === tab.name));
    if (missing.length > 0) {
      console.warn(
        `[tabs] the navigator built no route for ${missing.map((tab) => `"${tab.name}"`).join(', ')}. ` +
          'Those tabs will show an empty page.',
      );
    }
  }

  return (
    <NavigationContent>
      <TabsPager
        state={state}
        descriptors={descriptors}
        progress={progress}
        // A released swipe reports the page it landed on; the route follows it.
        // Routed through `selectTab` rather than straight to `commit` so a swipe
        // and a tap take exactly one path — including popping anything pushed
        // over the tabs.
        onCommit={selectTab}
      />
    </NavigationContent>
  );
}
