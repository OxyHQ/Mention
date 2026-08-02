import { useRef, useCallback, useEffect, useMemo } from 'react';
import { Platform } from 'react-native';
import {
  useLayoutScroll,
  extractOffsetY,
  type ScrollableRef,
  type ScrollableRefTarget,
  type ScrollEvent,
} from '@/context/LayoutScrollContext';
import { usePostsStore } from '@/stores/postsStore';
import { getFeedMeta } from '@/db/feedQueries';
import type { FeedType } from '@mention/shared-types';
import { isAuthorFeedFilter } from '@mention/shared-types/mtn/feedDescriptor';
import {
  isVirtualizedProfileGridTab,
  LAYOUT,
  type ProfileTab,
} from '../types';

interface UseProfileScrollOptions {
  profileId?: string;
  currentTab: ProfileTab;
  /**
   * Set while a LANE tab is open. A lane tab renders as `posts`, so the
   * author-feed narrowing below cannot tell it apart on `currentTab` alone — and
   * paging it as an author feed writes a page of the profile's whole output into
   * `user:<id>:posts`, a feed the lane tab does not read. Its `<Feed>` owns its
   * own pagination (it is fetched by the lane descriptor), so this pager stands
   * down entirely.
   */
  currentLaneId?: string;
}

interface ScrollSlice {
  hasMore: boolean;
  nextCursor?: string;
  isLoading: boolean;
}


/**
 * Hook for managing profile scroll behavior
 * Handles infinite scroll, scroll registration, and scroll-to functionality
 */
export function useProfileScroll({ profileId, currentTab, currentLaneId }: UseProfileScrollOptions) {
  const {
    scrollY,
    createAnimatedScrollHandler,
    registerScrollable,
    scrollToOffset,
    setScrollY,
  } = useLayoutScroll();

  // The active scroller: the profile ScrollView on non-feed tabs, the grid's
  // FlashList on virtualized ones.
  const scrollRef = useRef<ScrollableRef | null>(null);
  const loadingMoreRef = useRef(false);
  const unregisterRef = useRef<(() => void) | null>(null);
  const lastScrollCheckRef = useRef(0);

  // Store method refs for performance (avoid subscription on every scroll)
  const fetchUserFeedRef = useRef<((
    userId: string,
    request: { type: FeedType; cursor?: string; limit: number }
  ) => Promise<{ pending: boolean }>) | null>(null);

  const getUserSliceRef = useRef<((
    userId: string,
    type: FeedType
  ) => ScrollSlice | undefined) | null>(null);

  // Initialize store method refs
  useEffect(() => {
    const store = usePostsStore.getState();
    fetchUserFeedRef.current = store.fetchUserFeed;
    getUserSliceRef.current = (userId: string, type: FeedType) => {
      const feedKey = `user:${userId}:${type}`;
      const ui = usePostsStore.getState().feedUI[feedKey];
      const meta = getFeedMeta(feedKey);
      return {
        hasMore: meta?.hasMore ?? true,
        nextCursor: meta?.nextCursor,
        isLoading: ui?.isLoading ?? false,
      };
    };
  }, []);

  // Clear registration on unmount
  const clearRegistration = useCallback(() => {
    if (unregisterRef.current) {
      unregisterRef.current();
      unregisterRef.current = null;
    }
  }, []);

  // Track which profile we last registered for, so we only reset scroll on profile change
  const lastProfileRef = useRef<string | undefined>(undefined);

  // Assign scroll ref with registration
  const assignScrollRef = useCallback((node: ScrollableRefTarget | null) => {
    const scroller = node && 'getNode' in node ? node.getNode() : node;
    scrollRef.current = scroller;
    clearRegistration();
    if (scroller && registerScrollable) {
      // Only reset scroll position when navigating to a different profile,
      // not when switching tabs within the same profile
      if (lastProfileRef.current !== profileId) {
        setScrollY(0);
        lastProfileRef.current = profileId;
      }
      unregisterRef.current = registerScrollable(scroller);
    }
  }, [clearRegistration, registerScrollable, setScrollY, profileId]);

  // Shared near-bottom load-more trigger. It closes over the profile and the tab
  // rather than reading them from refs mirrored during render: that write is
  // illegal input for the React Compiler, and WHICH feed to page is the one thing
  // here that must never be stale. A lagging pair pages the profile or the tab
  // you just left — the request lands in `user:<other>:<other>`, so the list you
  // are actually looking at never grows and simply looks like it ended, while a
  // slice you cannot see fills up behind it.
  //
  // The identity churn this costs is bounded to a tab switch or a profile
  // change, both of which already re-render the whole screen (`assignScrollRef`
  // is keyed on `profileId` for the same reason), and `loadingMoreRef` absorbs
  // any duplicate call a fresh subscription delivers.
  const maybeLoadMore = useCallback((distanceFromBottom: number) => {
    if (distanceFromBottom >= LAYOUT.LOAD_MORE_THRESHOLD) return;
    if (!profileId || loadingMoreRef.current || !fetchUserFeedRef.current || !getUserSliceRef.current) {
      return;
    }
    // Three of the nine tabs — feeds, starter packs, lists — are not backed by an
    // author feed at all, and paging them is not merely pointless: the slice
    // getter below reports `hasMore: true` for a feed key nothing has ever
    // written, so scrolling one of those tabs to the bottom fires a real request
    // that `feedService.getUserFeed` coerces back to `posts` and files under
    // `user:<id>:feeds`. Narrow honestly against the descriptor's own filter set
    // rather than asserting the tab into `FeedType`, so a tab added to
    // `TAB_NAMES` without a feed behind it stops here too.
    if (!isAuthorFeedFilter(currentTab)) return;
    // A lane tab renders as `posts` and would pass the check above (see
    // `currentLaneId`): its feed is its own descriptor and pages itself.
    if (currentLaneId) return;
    // Native media/video grids own pagination through FlashList.onEndReached.
    // Running the profile's generic scroll detector too would issue a duplicate
    // request. On WEB there is no such owner — the web grid does not wire
    // `onEndReached` at all — so this stays the only pagination those tabs get,
    // and it must page the tab's OWN feed: `videos` is the author `videos`
    // descriptor, with its own cursor.
    if (Platform.OS !== 'web' && isVirtualizedProfileGridTab(currentTab)) return;

    const slice = getUserSliceRef.current(profileId, currentTab);
    if (slice && slice.hasMore && !slice.isLoading) {
      loadingMoreRef.current = true;
      const fetchUserFeed = fetchUserFeedRef.current;
      void (async () => {
        try {
          await fetchUserFeed(profileId, {
            type: currentTab,
            cursor: slice.nextCursor,
            limit: LAYOUT.FEED_LIMIT,
          });
        } finally {
          loadingMoreRef.current = false;
        }
      })();
    }
  }, [profileId, currentTab, currentLaneId]);

  // NATIVE scroll event handler with throttling + infinite scroll.
  const handleScrollEvent = useCallback((event: ScrollEvent) => {
    const now = Date.now();
    if (now - lastScrollCheckRef.current < LAYOUT.SCROLL_CHECK_THROTTLE) {
      return;
    }
    lastScrollCheckRef.current = now;

    const nativeEvent = event?.nativeEvent ?? {};
    const layoutMeasurement = nativeEvent.layoutMeasurement as { height?: number } | undefined;
    const contentSize = nativeEvent.contentSize as { height?: number } | undefined;

    const y = extractOffsetY(event);
    const viewHeight = layoutMeasurement?.height ?? 0;
    const contentHeight = contentSize?.height ?? 0;
    maybeLoadMore(contentHeight - (y + viewHeight));
  }, [maybeLoadMore]);

  // Create animated scroll handler (native only — web uses the document scroll).
  const onScroll = useMemo(
    () => createAnimatedScrollHandler(handleScrollEvent),
    [createAnimatedScrollHandler, handleScrollEvent]
  );

  // WEB infinite scroll: the profile renders in normal document flow (no inner
  // ScrollView), so pagination is driven by the same shared `scrollY` the header
  // animations consume — fed by LayoutScrollContext's window 'scroll' listener.
  // This is an Animated.Value subscription (mirrors HomeScreen's `scrollY`
  // listener), not a new DOM listener. No-op on native (`onScroll` handles it).
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const listenerId = scrollY.addListener(({ value }) => {
      const y = typeof value === 'number' ? value : 0;
      const docHeight = document.documentElement.scrollHeight;
      const viewHeight = window.innerHeight;
      maybeLoadMore(docHeight - (y + viewHeight));
    });
    return () => {
      scrollY.removeListener(listenerId);
    };
  }, [scrollY, maybeLoadMore]);

  // The active owner may be the profile ScrollView (non-feed tabs), Feed's
  // FlashList (virtualized tabs), or the web document. LayoutScrollContext
  // already tracks that owner, so the same stat-button action works in all
  // three modes.
  const scrollToContent = useCallback((offset: number) => {
    scrollToOffset(offset);
  }, [scrollToOffset]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearRegistration();
    };
  }, [clearRegistration]);

  return {
    scrollY,
    scrollRef,
    onScroll,
    assignScrollRef,
    scrollToContent,
  };
}
