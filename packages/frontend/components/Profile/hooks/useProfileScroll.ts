import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import { useFrontScroller } from '@oxy.so/bloom/screen';
import { feedSource } from '@/data/feeds';
import { isAuthorFeedFilter } from '@mention/shared-types/mtn/feedDescriptor';
import { isVirtualizedProfileGridTab, LAYOUT, type ProfileTab } from '../types';
import { useProfileDocumentPaging } from './useProfileDocumentPaging';

interface UseProfileScrollOptions {
  profileId?: string;
  currentTab: ProfileTab;
  currentLaneId?: string;
}

export interface ProfileScroll {
  /** Move the profile's scroller — its list, or the web document — to an offset. */
  scrollToContent: (offset: number) => void;
  /** Ask for the next page of the author feed the tab shows, once at a time. */
  loadMore: () => void;
}

/**
 * The profile's scroll: the jump to its tabs, and the paging of an author feed
 * that no `Feed` of its own pages. Native lists bind their Screen and page from
 * `onEndReached`; the web document pages from its scroll position.
 */
export function useProfileScroll({
  profileId,
  currentTab,
  currentLaneId,
}: UseProfileScrollOptions): ProfileScroll {
  const frontScroller = useFrontScroller();
  const loadingMoreRef = useRef(false);

  const loadMore = useCallback(() => {
    if (!profileId || loadingMoreRef.current) return;
    // Lanes and the feed tabs a `Feed` renders page themselves; so do native
    // grids, from their own list. The web grids follow the document.
    if (!isAuthorFeedFilter(currentTab) || currentLaneId) return;
    if (isVirtualizedProfileGridTab(currentTab) !== (Platform.OS === 'web')) return;
    loadingMoreRef.current = true;
    // The next page, if there is one; joins a read of the feed in flight.
    void feedSource
      .more({ type: currentTab, userId: profileId, limit: LAYOUT.FEED_LIMIT })
      .finally(() => {
        loadingMoreRef.current = false;
      });
  }, [profileId, currentTab, currentLaneId]);

  useProfileDocumentPaging(loadMore);

  const scrollToContent = useCallback(
    (offset: number) => frontScroller()?.scrollToOffset(offset),
    [frontScroller],
  );

  return { scrollToContent, loadMore };
}
