import { useRef, useCallback, useEffect, useMemo } from 'react';
import { Platform } from 'react-native';
import { useLayoutScroll, extractOffsetY, type ScrollEvent } from '@/context/LayoutScrollContext';
import { usePostsStore } from '@/stores/postsStore';
import type { FeedType } from '@mention/shared-types';
import { LAYOUT, type ProfileTab } from '../types';

interface UseProfileScrollOptions {
  profileId?: string;
  currentTab: ProfileTab;
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
export function useProfileScroll({ profileId, currentTab }: UseProfileScrollOptions) {
  const {
    scrollY,
    createAnimatedScrollHandler,
    registerScrollable,
    setScrollY,
  } = useLayoutScroll();

  // Refs - using any for ScrollView ref due to Animated wrapper complexity
  const scrollRef = useRef<any>(null);
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
      const { getFeedMeta } = require('@/db');
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
  const assignScrollRef = useCallback((node: any) => {
    scrollRef.current = node;
    clearRegistration();
    if (node && registerScrollable) {
      // Only reset scroll position when navigating to a different profile,
      // not when switching tabs within the same profile
      if (lastProfileRef.current !== profileId) {
        setScrollY(0);
        lastProfileRef.current = profileId;
      }
      unregisterRef.current = registerScrollable(node);
    }
  }, [clearRegistration, registerScrollable, setScrollY, profileId]);

  // Use refs for values that change on tab switch to keep handleScrollEvent stable
  const currentTabRef = useRef(currentTab);
  currentTabRef.current = currentTab;
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;

  // Shared near-bottom load-more trigger. Stable — reads tab/profileId from refs.
  const maybeLoadMore = useCallback((distanceFromBottom: number) => {
    if (distanceFromBottom >= LAYOUT.LOAD_MORE_THRESHOLD) return;
    const pid = profileIdRef.current;
    const tab = currentTabRef.current;
    if (!pid || loadingMoreRef.current || !fetchUserFeedRef.current || !getUserSliceRef.current) {
      return;
    }
    const slice = getUserSliceRef.current(pid, tab as FeedType);
    if (slice && slice.hasMore && !slice.isLoading) {
      loadingMoreRef.current = true;
      const fetchUserFeed = fetchUserFeedRef.current;
      void (async () => {
        try {
          await fetchUserFeed(pid, {
            type: tab as FeedType,
            cursor: slice.nextCursor,
            limit: LAYOUT.FEED_LIMIT,
          });
        } finally {
          loadingMoreRef.current = false;
        }
      })();
    }
  }, []);

  // NATIVE scroll event handler with throttling + infinite scroll. Stable
  // callback — uses refs for tab/profileId to avoid re-creating onScroll.
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

  // Scroll to specific position. WEB: the document is the scroller (the profile
  // renders in normal flow, no inner ScrollView), so drive the window. NATIVE:
  // the inner Animated.ScrollView owns the scroll.
  const scrollToContent = useCallback((offset: number) => {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: offset, behavior: 'smooth' });
      }
      return;
    }
    scrollRef.current?.scrollTo?.({
      y: offset,
      animated: true,
    });
  }, []);

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

