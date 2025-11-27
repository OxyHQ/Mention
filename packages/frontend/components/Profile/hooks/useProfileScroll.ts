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
      const state = usePostsStore.getState();
      return state.userFeeds[userId]?.[type];
    };
  }, []);

  // Clear registration on unmount
  const clearRegistration = useCallback(() => {
    if (unregisterRef.current) {
      unregisterRef.current();
      unregisterRef.current = null;
    }
  }, []);

  // Assign scroll ref with registration
  const assignScrollRef = useCallback((node: any) => {
    scrollRef.current = node;
    clearRegistration();
    if (node && registerScrollable) {
      unregisterRef.current = registerScrollable(node);
    }
  }, [clearRegistration, registerScrollable]);

  // Scroll event handler with throttling and infinite scroll
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
        if (!profileId || loadingMoreRef.current || !fetchUserFeedRef.current || !getUserSliceRef.current) {
          return;
        }

        const slice = getUserSliceRef.current(profileId, currentTab as FeedType);
        if (slice && slice.hasMore && !slice.isLoading) {
          loadingMoreRef.current = true;
          void (async () => {
            try {
              await fetchUserFeedRef.current!(profileId, {
                type: currentTab as FeedType,
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
  }, [currentTab, profileId]);

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

