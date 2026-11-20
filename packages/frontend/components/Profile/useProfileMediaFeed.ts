import { useCallback, useMemo } from 'react';
import { skip, useList, useListState, useStore, withStore } from '@oxy.so/bloom-data';
import { useAuth } from '@oxy.so/services/ui/client';
import type { FeedItem } from '@/db/schema';
import { Feed, type FeedIdentity, feedKey, feedPosts, feedSource } from '@/data/feeds';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

const PROFILE_MEDIA_FEED_LIMIT = 50;
const PROFILE_POSTS_FEED_LIMIT = 60;

interface ProfileMediaFeedArgs {
  userId?: string;
  isPrivate?: boolean;
  isOwnProfile?: boolean;
  /**
   * Which author descriptor backs the grid: `media` for the Media tab,
   * `videos` for the Videos tab. Each is a real server-side filter
   * (`author|<id>|<filter>`) with its own cursor, so the Videos tab paginates
   * over videos rather than over a mixed pool it then discards most of.
   */
  filter?: 'media' | 'videos';
}

/**
 * Shared data source for the profile Media and Videos grids. Loads the user's
 * primary feed for the requested `filter`, falling back to the held `posts`
 * feed for media extraction while that feed is empty, and returns the flattened
 * item list both grids iterate. The two grids differ only in how they turn
 * these items into cells, so the feed plumbing lives here once.
 */
export function useProfileMediaFeed({
  userId,
  isPrivate,
  isOwnProfile,
  filter = 'media',
}: ProfileMediaFeedArgs) {
  const { user } = useAuth();
  const viewerId = user?.id;
  const readable = Boolean(userId) && (!isPrivate || Boolean(isOwnProfile));

  // The viewer is part of the read: visibility of follower- or owner-gated
  // media depends on who is asking, and an account switch opens another store.
  const primary: FeedIdentity = { type: filter, userId, viewerId, limit: PROFILE_MEDIA_FEED_LIMIT };
  const primaryView = useList(feedSource, ...(readable ? ([primary] as [FeedIdentity]) : [skip]));

  // Fallback: the profile's posts feed, when another screen holds it (the Posts
  // tab), so media can still be extracted from regular posts while the
  // filtered feed is empty. Read as held; nothing reads it for the grid.
  const postsList = useListState(Feed, userId ? feedKey({ type: 'posts', userId }) : null);

  const store = useStore();
  const primaryItems = useMemo(
    () => withStore(store, () => feedPosts(primaryView.list)),
    [store, primaryView.list],
  );
  const postsItems = useMemo(
    () => withStore(store, () => feedPosts(postsList)),
    [store, postsList],
  );
  const items = useMemo<FeedItem[]>(
    () => (primaryItems.length > 0 ? primaryItems : postsItems),
    [primaryItems, postsItems],
  );

  const usingPrimary = primaryItems.length > 0 || postsItems.length === 0;
  const { more: morePrimary } = primaryView;
  const loadMore = useCallback(() => {
    if (!readable || !userId) return;
    if (usingPrimary) void morePrimary();
    else void feedSource.more({ type: 'posts', userId, viewerId, limit: PROFILE_POSTS_FEED_LIMIT });
  }, [readable, usingPrimary, morePrimary, userId, viewerId]);

  return {
    primaryFeed: {
      items: primaryItems,
      isLoading: primaryView.isFetching,
      hasMore: primaryView.hasMore,
    },
    postsFeed: { items: postsItems, isLoading: false, hasMore: postsList?.hasMore ?? false },
    items,
    loadMore,
    restorationKey: JSON.stringify(viewerQueryKeys.feed(viewerId, filter, userId)),
  };
}
