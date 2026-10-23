import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import { useFrontScroller } from '@/context/ScreenReselectContext';
import { usePostsStore } from '@/stores/postsStore';
import { getFeedMeta } from '@/db/feedQueries';
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
    const feedKey = `user:${profileId}:${currentTab}`;
    const meta = getFeedMeta(feedKey);
    const store = usePostsStore.getState();
    if (!(meta?.hasMore ?? true) || !meta?.nextCursor || store.feedUI[feedKey]?.isLoading) return;
    loadingMoreRef.current = true;
    void store
      .fetchUserFeed(profileId, {
        type: currentTab,
        cursor: meta.nextCursor,
        limit: LAYOUT.FEED_LIMIT,
      })
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
