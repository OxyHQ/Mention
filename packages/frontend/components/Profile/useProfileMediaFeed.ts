import { useCallback, useEffect, useMemo } from 'react';
import { useAuth } from '@oxyhq/services/ui/client';
import { usePostsStore, useUserFeedSelector } from '@/stores/postsStore';
import type { FeedItem } from '@/db';

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
 * primary feed for the requested `filter`, transparently falling back to the
 * `posts` feed for media extraction when that feed resolves empty, and returns
 * the flattened item list both grids iterate. The two grids differ only in how
 * they turn these items into cells, so the feed plumbing lives here once.
 */
export function useProfileMediaFeed({ userId, isPrivate, isOwnProfile, filter = 'media' }: ProfileMediaFeedArgs) {
    const { user } = useAuth();
    const viewerId = user?.id;
    const { fetchUserFeed } = usePostsStore();
    const primaryFeed = useUserFeedSelector(userId || '', filter);
    const postsFeed = useUserFeedSelector(userId || '', 'posts');

    useEffect(() => {
        if (!userId || (isPrivate && !isOwnProfile)) return;

        fetchUserFeed(userId, { type: filter, limit: PROFILE_MEDIA_FEED_LIMIT });
        // `viewerId` is in the deps so the feed refetches when the viewer's auth
        // session resolves on cold boot — visibility of follower/owner-gated
        // media depends on who is asking, and the request would otherwise run
        // once while anonymous and never refresh.
    }, [userId, viewerId, fetchUserFeed, filter, isPrivate, isOwnProfile]);

    // Fallback: if the primary feed finished and is empty, load the posts feed so
    // media can still be extracted from regular posts. Deliberately UNFILTERED —
    // it is the shared escape hatch for a profile whose media never made it into
    // a filtered feed, so narrowing it to `videos` would defeat its purpose.
    useEffect(() => {
        if (!userId || (isPrivate && !isOwnProfile)) return;

        const isLoaded = !!primaryFeed && !primaryFeed.isLoading;
        const isEmpty = (primaryFeed?.items?.length || 0) === 0;
        const postsLoaded = !!postsFeed;

        if (isLoaded && isEmpty && !postsLoaded) {
            fetchUserFeed(userId, { type: 'posts', limit: PROFILE_POSTS_FEED_LIMIT });
        }
    }, [userId, viewerId, primaryFeed, primaryFeed?.isLoading, primaryFeed?.items?.length, postsFeed, fetchUserFeed, isPrivate, isOwnProfile]);

    const items = useMemo<FeedItem[]>(
        () => (primaryFeed?.items?.length ? primaryFeed.items : (postsFeed?.items || [])),
        [primaryFeed?.items, postsFeed?.items],
    );

    const loadMore = useCallback(() => {
        if (!userId || (isPrivate && !isOwnProfile)) return;

        const usingPrimaryFeed =
            (primaryFeed?.items?.length ?? 0) > 0 || !postsFeed;
        const activeFeed = usingPrimaryFeed ? primaryFeed : postsFeed;
        const type = usingPrimaryFeed ? filter : 'posts';
        if (
            !activeFeed ||
            activeFeed.isLoading ||
            !activeFeed.hasMore ||
            !activeFeed.nextCursor
        ) return;

        void fetchUserFeed(userId, {
            type,
            cursor: activeFeed.nextCursor,
            limit: type === 'posts'
                ? PROFILE_POSTS_FEED_LIMIT
                : PROFILE_MEDIA_FEED_LIMIT,
        });
    }, [
        fetchUserFeed,
        filter,
        isOwnProfile,
        isPrivate,
        primaryFeed,
        postsFeed,
        userId,
    ]);

    return { primaryFeed, postsFeed, items, loadMore };
}
