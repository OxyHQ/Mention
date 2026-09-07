import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';
import { useAuth } from '@oxyhq/services/ui/client';

import {
  BAR_SETTLE_SPRING,
  CHROME_HIDDEN_BY_PAGE,
  PAGES,
  pageIndexForPathname,
  pageToBar,
  tabHref,
} from '@/components/navigation/tabs';

const IS_WEB = Platform.OS === 'web';

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
   * Switch to a PAGE by index, through the navigator's own imperative API rather
   * than a route push, so a swipe does not leave a history entry per page.
   */
  commit: (pageIndex: number) => void;
  /**
   * True when the registrant writes `progress` AND `chromeProgress` itself,
   * every frame. The pager
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
   * The settled BAR ITEM, or -1 when the bar draws nothing for this route.
   * Handed to Bloom's `activeIndex`, which is what decides whether the
   * highlight is drawn at all. Position and visibility are separate questions
   * with one writer each; see `docs/tab-bar.mdx`.
   *
   * -1 covers two different situations and deliberately does not tell them
   * apart, because the bar's answer is the same either way: a pushed detail
   * route, and a root page the bar draws no item for. Anything that needs the
   * difference reads {@link TabPagerValue.activePage}.
   */
  activeIndex: number;
  /**
   * How far the reader is onto a page the bar draws no item for: 0 on a page it
   * does, 1 on one it does not, fractional under the finger.
   *
   * The bottom bar reads this to fade itself out as the camera comes in, which
   * is why it is continuous rather than a boolean — a bar that popped away when
   * the page committed would announce the commit instead of following the
   * finger. It is a SEPARATE value from `progress` on purpose: where the
   * highlight sits and whether there is a bar at all are different questions,
   * and `progress` must stay inside Bloom's range whatever this one is doing.
   */
  chromeProgress: SharedValue<number>;
  /**
   * The settled PAGE, or -1 when the reader is off the root pages entirely —
   * i.e. something is pushed over them. This is the honest test for that, and
   * `activeIndex < 0` is not.
   */
  activePage: number;
  /** Go to a PAGE by index. Pops anything pushed over the pages first. */
  selectTab: (pageIndex: number) => void;
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
  const viewerUsername = user?.username;
  const progress = useSharedValue(0);
  const chromeProgress = useSharedValue(0);
  const committerRef = useRef<TabCommitter | null>(null);

  // The viewer's handle goes in unconditionally; whether it changes the answer
  // is `tabHref`'s decision, not this file's. On web the profile tab IS
  // `/@<handle>`, so that pathname selects it; on native the tab is `/you` and
  // `/@<handle>` is an ordinary pushed route that must select nothing.
  const activePage = pageIndexForPathname(pathname, viewerUsername);
  const activeIndex = pageToBar(activePage);

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
    progress.value = withSpring(activeIndex, BAR_SETTLE_SPRING);
  }, [activeIndex, progress]);

  /**
   * The same job for the bar's PRESENCE, on the paths where nothing drives it.
   *
   * Written even when `activePage` is -1, unlike `progress`: a pushed detail
   * route is not a page the bar hides for, and leaving a stale 1 behind would
   * take the bar away on a screen that wants it. The only page that hides it
   * today is the camera, which is native-only, so on web this settles at 0 and
   * stays there.
   */
  useEffect(() => {
    if (committerRef.current?.drivesProgress) return;
    chromeProgress.value = withSpring(
      activePage >= 0 ? (CHROME_HIDDEN_BY_PAGE[activePage] ?? 0) : 0,
      BAR_SETTLE_SPRING,
    );
  }, [activePage, chromeProgress]);

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
    for (const page of PAGES) {
      router.prefetch(tabHref(page, viewerUsername));
    }
  }, [viewerUsername]);

  const selectTab = useCallback(
    (pageIndex: number) => {
      const page = PAGES[pageIndex];
      if (!page) return;
      // The highlight is a BAR position, so it is written in bar units whatever
      // space the caller argued in. A page the bar draws no item for answers -1
      // here, and -1 is never written — see the settle effect above.
      const barIndex = pageToBar(pageIndex);

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
        if (barIndex >= 0) progress.value = withSpring(barIndex, BAR_SETTLE_SPRING);
        router.navigate(tabHref(page, viewerUsername));
        return;
      }

      // WITH a navigator, switching tab changes what sits UNDERNEATH whatever is
      // pushed — so a tab press from an open post would leave the reader looking
      // at the post with a different tab behind it. Dismissing is right there,
      // and only there: `activeIndex < 0` is precisely "what is on screen is not
      // a tab", which is the state that means something is pushed over them.
      // `activePage`, not `activeIndex`: the question is "is the reader off the
      // root pages", and a page the bar draws no item for is still a root page.
      // Reading the bar's -1 here would pop the stack on the way back from one.
      if (activePage < 0 && router.canDismiss()) {
        router.dismissAll();
      }

      // Optimism is only ours to apply when nobody else owns the value. The
      // pager animates its own way to the page and writes `progress` as it goes.
      if (!committer.drivesProgress && barIndex >= 0) {
        progress.value = withSpring(barIndex, BAR_SETTLE_SPRING);
      }
      committer.commit(pageIndex);
    },
    [progress, activePage, viewerUsername],
  );

  const value = useMemo<TabPagerValue>(
    () => ({ progress, chromeProgress, activeIndex, activePage, selectTab, registerCommitter }),
    [progress, chromeProgress, activeIndex, activePage, selectTab, registerCommitter],
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
