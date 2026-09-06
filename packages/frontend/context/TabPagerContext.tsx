import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';
import { useAuth } from '@oxyhq/services/ui/client';

import { TABS, tabIndexForPathname } from '@/components/navigation/tabs';

const IS_WEB = Platform.OS === 'web';

/**
 * How fast the highlight travels to a tab nobody dragged it to — a tap, a deep
 * link, a back gesture. Matched to Bloom's own `SLIDE_SPRING` by feel rather
 * than by import: Bloom does not export it, and the two are allowed to differ
 * (this one also has to look right against a page that is NOT sliding, on web).
 */
const SETTLE_SPRING = { duration: 420, dampingRatio: 0.82 } as const;

/**
 * What the tabs navigator, once mounted, takes over from this provider.
 *
 * The provider exists ABOVE the navigator because the bottom bar does too — the
 * bar renders over pushed detail routes, so it cannot live inside the tab
 * layout — and because on web there is no navigator at all. So the navigator
 * registers itself here when it mounts and unregisters when it does not.
 */
export interface TabCommitter {
  /**
   * Switch to a tab by index, through the navigator's own imperative API rather
   * than a route push, so a swipe does not leave a history entry per page.
   */
  commit: (index: number) => void;
  /**
   * True when the registrant writes `progress` itself, every frame. The pager
   * does; nothing else does. While it is true this provider must not touch
   * `progress` — two writers on one shared value is the exact race Bloom's
   * `activeProgress` documentation warns about.
   */
  drivesProgress: boolean;
}

interface TabPagerValue {
  /**
   * The bottom bar highlight's POSITION, in tab units, on the UI thread.
   * Fractional while a page is in flight. Handed to Bloom's `activeProgress`.
   */
  progress: SharedValue<number>;
  /**
   * The settled tab, or -1 when what the reader is looking at is not a tab.
   * Handed to Bloom's `activeIndex`, which is what decides whether the
   * highlight is drawn at all. Position and visibility are separate questions
   * with one writer each; see `docs/tab-bar.mdx`.
   */
  activeIndex: number;
  /** Go to a tab. Pops anything pushed over the tabs first. */
  selectTab: (index: number) => void;
  registerCommitter: (committer: TabCommitter | null) => void;
}

const TabPagerContext = createContext<TabPagerValue | null>(null);

/**
 * The one authority on which root tab is showing and where the bar's highlight
 * sits.
 *
 * IT REPLACES A ROUND TRIP. The bar used to derive its index from
 * `usePathname()`, which put Bloom's `TabBar` on its controlled path: the
 * highlight was re-asserted from a React render that could not happen until the
 * incoming screen had finished rendering. On native that meant waiting behind a
 * 2270-line reels screen mounting; on web, behind an async route chunk (597ms,
 * measured — `components/Profile/ProfileChromeFrame.web.tsx`). That wait is the
 * reported "it changes a few seconds later", and it is why `progress` is
 * written when the reader ACTS rather than when the route lands.
 *
 * Mounted above both the bar and the tabs layout (`AppShellProviders`), so it
 * is the same value on every route — including the pushed ones the bar renders
 * over, where `activeIndex` is -1 and the highlight is correctly absent.
 */
export function TabPagerProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const progress = useSharedValue(0);
  const committerRef = useRef<TabCommitter | null>(null);

  // The viewer's handle is passed ON WEB ONLY, because the reason for that match
  // is a web-only one: there `/you` redirects to `/@<handle>` (the profile chrome
  // lives in the `[username]` layout), so without it the bar would show no
  // selection on the one profile a reader looks at most.
  //
  // On NATIVE `/you` is the tab and `/@<handle>` is an ordinary pushed route —
  // a copy of your own profile opened from a post row. Treating it as the tab
  // there would light the pill for a screen sitting OVER the tabs, and would
  // also tell `selectTab` below that nothing is pushed when something is.
  const activeIndex = tabIndexForPathname(pathname, IS_WEB ? user?.username : undefined);

  const registerCommitter = useCallback((committer: TabCommitter | null) => {
    committerRef.current = committer;
  }, []);

  /**
   * Keep `progress` honest about where the selection actually ended up.
   *
   * Only when nothing else is driving it. With the pager mounted this would be
   * a second writer racing the finger; without it — on web, and on native
   * before the navigator mounts — it is the only thing that moves the highlight
   * after a navigation this provider did not perform: a deep link, a push
   * notification, a browser Back.
   *
   * -1 is never written. It is a real POSITION (one item-width left of the
   * first tab), not an absence; the highlight disappearing on a non-tab route
   * is `activeIndex`'s job, and the capsule has to fade out where it stands
   * rather than travel off the end on its way.
   */
  useEffect(() => {
    if (committerRef.current?.drivesProgress) return;
    if (activeIndex < 0) return;
    progress.value = withSpring(activeIndex, SETTLE_SPRING);
  }, [activeIndex, progress]);

  /**
   * WEB ONLY: warm every tab's route chunk once, up front.
   *
   * On web each route is an async chunk and there is no navigator keeping the
   * others alive, so the first visit to a tab pays a network fetch before it can
   * paint anything — 597ms for one such chunk, measured on production
   * (`components/Profile/ProfileChromeFrame.web.tsx`). That fetch is the other
   * half of "it takes seconds"; the highlight already moves on touch-up, and
   * this is what stops the SCREEN arriving long after it.
   *
   * Up front rather than on hover or on press: a bar is a thumb target with no
   * hover to warm on, and by the time there is a press the fetch is the wait.
   * `router.prefetch` is expo-router's own imperative API; on native it is
   * pointless here — the tabs are mounted — so it is not called at all.
   */
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    for (const tab of TABS) {
      router.prefetch(tab.href);
    }
  }, []);

  const selectTab = useCallback(
    (index: number) => {
      const tab = TABS[index];
      if (!tab) return;

      const committer = committerRef.current;

      // NO TABS NAVIGATOR — web, and native before the layout mounts. The route
      // IS the whole operation here, so move the highlight and navigate.
      //
      // Nothing is dismissed on this path, and that is the fix for a real bug
      // rather than an omission. `router.canDismiss()` walks DOWN the focused
      // branch for any stack with more than one route, and on web every level of
      // this app is a `<Slot/>` — a StackRouter — so it answers true the moment
      // the reader has navigated anywhere at all. A `dismissAll()` here
      // therefore fired on EVERY tab press, and the two do not compose:
      // `dismissAll` queues `POP_TO_TOP` while `navigate` queues a link whose
      // action `routingQueue.run` COMPUTES when it runs it, against a tree the
      // pop has just changed. The reader saw the tab go and come straight back.
      // There is nothing to dismiss here anyway: that stack history is the
      // browser's, not detail screens sitting over the tabs.
      if (!committer) {
        progress.value = withSpring(index, SETTLE_SPRING);
        router.navigate(tab.href);
        return;
      }

      // WITH a navigator, switching tab changes what sits UNDERNEATH whatever is
      // pushed — so a tab press from an open post would leave the reader looking
      // at the post with a different tab behind it. Dismissing is right there,
      // and only there: `activeIndex < 0` is precisely "what is on screen is not
      // a tab", which is the state that means something is pushed over them.
      if (activeIndex < 0 && router.canDismiss()) {
        router.dismissAll();
      }

      // Optimism is only ours to apply when nobody else owns the value. The
      // pager animates its own way to the page and writes `progress` as it goes.
      if (!committer.drivesProgress) {
        progress.value = withSpring(index, SETTLE_SPRING);
      }
      committer.commit(index);
    },
    [progress, activeIndex],
  );

  const value = useMemo<TabPagerValue>(
    () => ({ progress, activeIndex, selectTab, registerCommitter }),
    [progress, activeIndex, selectTab, registerCommitter],
  );

  return <TabPagerContext.Provider value={value}>{children}</TabPagerContext.Provider>;
}

export function useTabPager(): TabPagerValue {
  const ctx = useContext(TabPagerContext);
  if (!ctx) {
    throw new Error('useTabPager must be used within a TabPagerProvider');
  }
  return ctx;
}
