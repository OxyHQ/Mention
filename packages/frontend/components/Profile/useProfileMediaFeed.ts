import { useEffect, useMemo } from 'react';
import { useAuth } from '@oxyhq/services';
import { usePostsStore, useUserFeedSelector } from '@/stores/postsStore';
import type { FeedItem } from '@/db';

const PROFILE_MEDIA_FEED_LIMIT = 50;
const PROFILE_POSTS_FEED_LIMIT = 60;

interface ProfileMediaFeedArgs {
    userId?: string;
    isPrivate?: boolean;
    isOwnProfile?: boolean;
}

/**
 * Shared data source for the profile Media and Videos grids. Loads the user's
 * `media` feed, transparently falling back to the `posts` feed for media
 * extraction when the media feed resolves empty, and returns the flattened item
 * list both grids iterate. The two grids differ only in how they turn these
 * items into cells, so the feed plumbing lives here once.
 */
export function useProfileMediaFeed({ userId, isPrivate, isOwnProfile }: ProfileMediaFeedArgs) {
    const { user } = useAuth();
    const viewerId = user?.id;
    const { fetchUserFeed } = usePostsStore();
    const mediaFeed = useUserFeedSelector(userId || '', 'media');
    const postsFeed = useUserFeedSelector(userId || '', 'posts');

    useEffect(() => {
        if (!userId || (isPrivate && !isOwnProfile)) return;

        fetchUserFeed(userId, { type: 'media', limit: PROFILE_MEDIA_FEED_LIMIT });
        // `viewerId` is in the deps so the feed refetches when the viewer's auth
        // session resolves on cold boot — visibility of follower/owner-gated
        // media depends on who is asking, and the request would otherwise run
        // once while anonymous and never refresh.
    }, [userId, viewerId, fetchUserFeed, isPrivate, isOwnProfile]);

    // Fallback: if the media feed finished and is empty, load the posts feed so
    // media can still be extracted from regular posts.
    useEffect(() => {
        if (!userId || (isPrivate && !isOwnProfile)) return;

        const isLoaded = !!mediaFeed && !mediaFeed.isLoading;
        const isEmpty = (mediaFeed?.items?.length || 0) === 0;
        const postsLoaded = !!postsFeed;

        if (isLoaded && isEmpty && !postsLoaded) {
            fetchUserFeed(userId, { type: 'posts', limit: PROFILE_POSTS_FEED_LIMIT });
        }
    }, [userId, viewerId, mediaFeed, mediaFeed?.isLoading, mediaFeed?.items?.length, postsFeed, fetchUserFeed, isPrivate, isOwnProfile]);

    const items = useMemo<FeedItem[]>(
        () => (mediaFeed?.items?.length ? mediaFeed.items : (postsFeed?.items || [])),
        [mediaFeed?.items, postsFeed?.items],
    );

    return { mediaFeed, postsFeed, items };
}
