import { useRef, useCallback, useEffect, useMemo } from 'react';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
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
  ) => Promise<void>) | null>(null);

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

  // Scroll event handler with throttling and infinite scroll
  // Stable callback — uses refs for tab/profileId to avoid re-creating onScroll
  const handleScrollEvent = useCallback((event: any) => {
    const now = Date.now();
    if (now - lastScrollCheckRef.current < LAYOUT.SCROLL_CHECK_THROTTLE) {
      return;
    }
    lastScrollCheckRef.current = now;

    try {
      const nativeEvent = event?.nativeEvent ?? {};
      const contentOffset = nativeEvent.contentOffset ?? {};
      const layoutMeasurement = nativeEvent.layoutMeasurement ?? {};
      const contentSize = nativeEvent.contentSize ?? {};

      // Fallback for web
      const fallbackY = typeof nativeEvent.target?.scrollTop === 'number'
        ? nativeEvent.target.scrollTop
        : typeof event?.target?.scrollTop === 'number'
          ? event.target.scrollTop
          : 0;

      const y = typeof contentOffset.y === 'number' ? contentOffset.y : fallbackY;
      const viewHeight = layoutMeasurement?.height || 0;
      const contentHeight = contentSize?.height || 0;
      const distanceFromBottom = contentHeight - (y + viewHeight);

      // Load more when near bottom
      if (distanceFromBottom < LAYOUT.LOAD_MORE_THRESHOLD) {
        const pid = profileIdRef.current;
        const tab = currentTabRef.current;
        if (!pid || loadingMoreRef.current || !fetchUserFeedRef.current || !getUserSliceRef.current) {
          return;
        }

        const slice = getUserSliceRef.current(pid, tab as FeedType);
        if (slice && slice.hasMore && !slice.isLoading) {
          loadingMoreRef.current = true;
          void (async () => {
            try {
              await fetchUserFeedRef.current!(pid, {
                type: tab as FeedType,
                cursor: slice.nextCursor,
                limit: LAYOUT.FEED_LIMIT,
              });
            } finally {
              loadingMoreRef.current = false;
            }
          })();
        }
      }
    } catch {
      // Ignore scroll read errors
    }
  }, []);

  // Create animated scroll handler
  const onScroll = useMemo(
    () => createAnimatedScrollHandler(handleScrollEvent),
    [createAnimatedScrollHandler, handleScrollEvent]
  );

  // Scroll to specific position
  const scrollToContent = useCallback((offset: number) => {
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

