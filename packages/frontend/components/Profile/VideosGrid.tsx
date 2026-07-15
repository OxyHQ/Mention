import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Dimensions,
    FlatList,
    TouchableOpacity,
    View,
} from 'react-native';
import { Spinner } from '@/components/ui/Spinner';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { usePostsStore, useUserFeedSelector } from '@/stores/postsStore';
import { EmptyState } from '@/components/common/EmptyState';
import { Video } from '@/assets/icons/video-icon';
import { videoPosterUrl } from '@/utils/imageUrlCache';
import VideoPosterCell from '@/components/common/VideoPosterCell';
import { isVideoMediaRef } from '@/utils/mediaTypes';

interface VideosGridProps {
    userId?: string;
    isPrivate?: boolean;
    isOwnProfile?: boolean;
}

interface VideoGridEntry {
    postId: string;
    /**
     * Static poster URL: Oxy `thumb` variant for native assets, or the backend
     * `/media/poster` frame for federated videos. Undefined only when no sensible
     * poster exists; the cell falls back to a video-icon placeholder on
     * 404/load error too.
     */
    posterUri?: string;
    mediaIndex: number;
}

const NUM_COLUMNS = 3;
const GAP = 1;
const H_PADDING = 0;
const PROFILE_VIDEO_FEED_LIMIT = 50;
const PROFILE_POSTS_FEED_LIMIT = 60;

const VideosGrid: React.FC<VideosGridProps> = ({ userId, isPrivate, isOwnProfile }) => {
    const { oxyServices, user } = useAuth();
    const viewerId = user?.id;
    const router = useRouter();
    const theme = useTheme();
    const { t } = useTranslation();
    const { fetchUserFeed } = usePostsStore();
    const mediaFeed = useUserFeedSelector(userId || '', 'media');
    const postsFeed = useUserFeedSelector(userId || '', 'posts');
    const [containerWidth, setContainerWidth] = useState<number>(Dimensions.get('window').width);
    const itemSize = useMemo(() => {
        const totalGap = GAP * (NUM_COLUMNS - 1) + H_PADDING * 2;
        return Math.floor((containerWidth - totalGap) / NUM_COLUMNS);
    }, [containerWidth]);

    useEffect(() => {
        if (!userId || (isPrivate && !isOwnProfile)) return;

        fetchUserFeed(userId, { type: 'media', limit: PROFILE_VIDEO_FEED_LIMIT });
        // `viewerId` is in the deps so the feed refetches when the viewer's auth
        // session resolves on cold boot — visibility of follower/owner-gated
        // videos depends on who is asking, and the request would otherwise run
        // once while anonymous and never refresh.
    }, [userId, viewerId, fetchUserFeed, isPrivate, isOwnProfile]);

    useEffect(() => {
        if (!userId || (isPrivate && !isOwnProfile)) return;

        const isLoaded = !!mediaFeed && !mediaFeed.isLoading;
        const isEmpty = (mediaFeed?.items?.length || 0) === 0;
        const postsLoaded = !!postsFeed;

        if (isLoaded && isEmpty && !postsLoaded) {
            fetchUserFeed(userId, { type: 'posts', limit: PROFILE_POSTS_FEED_LIMIT });
        }
    }, [userId, viewerId, mediaFeed, mediaFeed?.isLoading, mediaFeed?.items?.length, postsFeed, fetchUserFeed, isPrivate, isOwnProfile]);

    /**
     * Resolve a static video poster. Prefer the server-resolved final `posterUrl`
     * (fallback `thumbUrl`) from the media object; fall back to the legacy client
     * resolver for a raw id/url string (Oxy `thumb` / backend `/media/poster`).
     * Undefined → icon placeholder. A 404/error from the URL is handled by the
     * cell's own image-error fallback.
     */
    const resolvePosterUri = useCallback(
        (ref?: string | { posterUrl?: string; thumbUrl?: string; url?: string; id?: string }): string | undefined => {
            if (!ref) return undefined;
            if (typeof ref !== 'string') {
                const serverUrl = ref.posterUrl || ref.thumbUrl;
                if (serverUrl) return serverUrl;
            }
            const path = typeof ref === 'string' ? ref : (ref.id || ref.url);
            return videoPosterUrl(path ?? '', oxyServices);
        },
        [oxyServices]
    );

    const videoItems = useMemo<VideoGridEntry[]>(() => {
        const out: VideoGridEntry[] = [];
        const items = (mediaFeed?.items?.length ? mediaFeed.items : (postsFeed?.items || [])) as any[];

        // A media reference is either a raw id/url string (legacy) or a media object
        // carrying the server-resolved final URLs.
        type MediaRef = string | { id?: string; url?: string; src?: string; path?: string; thumbUrl?: string; posterUrl?: string };

        const pickIdOrUrl = (x: any): string | undefined => {
            if (!x) return undefined;
            if (typeof x === 'string') return x;
            return x.id || x.url || x.src || x.path || undefined;
        };

        const pushVideoSources = (
            targetId: string,
            sources: (MediaRef | undefined)[],
            postType?: string,
            mediaTypes?: (string | undefined)[]
        ) => {
            const collected = sources.filter(Boolean) as MediaRef[];
            const seen = new Set<string>();

            collected.forEach((ref, idx) => {
                const key = pickIdOrUrl(ref);
                if (!key) return;
                const isVideo = isVideoMediaRef(key, { postType, mediaType: mediaTypes?.[idx] });

                if (!isVideo) return; // Only include videos
                if (seen.has(key)) return;
                seen.add(key);
                out.push({ postId: targetId, posterUri: resolvePosterUri(ref), mediaIndex: idx });
            });
        };

        const extractFrom = (post: any, targetId: string) => {
            const postType = post?.type || post?.content?.type;
            const media: any[] = Array.isArray(post?.content?.media) ? post.content.media : [];
            const mediaTypes = media.map((m: any) => m?.type);

            if (media.length > 0) {
                // Pass the media objects so server URLs survive into the resolver.
                pushVideoSources(targetId, media, postType, mediaTypes);
            } else if (post?.videoUrl || post?.video) {
                pushVideoSources(targetId, [pickIdOrUrl(post.videoUrl || post.video)], postType);
            }
        };

        items.forEach((post: any) => {
            const id = post?.id || post?._id || post?.postId;
            if (!id) return;
            extractFrom(post, String(id));
        });

        return out;
    }, [mediaFeed?.items, postsFeed?.items, resolvePosterUri]);

    const isLoading = (mediaFeed?.isLoading || postsFeed?.isLoading) && videoItems.length === 0;

    const gridItemStyle = useMemo(() => ({
        width: itemSize,
        height: itemSize,
    }), [itemSize]);

    const renderItem = useCallback(({ item }: { item: VideoGridEntry }) => {
        const handlePress = () => {
            router.push(`/videos?postId=${item.postId}`);
        };

        return (
            <TouchableOpacity
                activeOpacity={0.8}
                style={gridItemStyle}
                onPress={handlePress}
            >
                <VideoPosterCell
                    posterUri={item.posterUri}
                    size={itemSize}
                    placeholderColor={theme.colors.textSecondary}
                    badge="corner"
                />
            </TouchableOpacity>
        );
    }, [itemSize, router, gridItemStyle, theme.colors.textSecondary]);

    const keyExtractor = useCallback((it: VideoGridEntry, index: number) =>
        `${it.postId}:${it.mediaIndex ?? index}`, []);

    const getItemLayout = useCallback((_: ArrayLike<VideoGridEntry> | null | undefined, index: number) => {
        const size = itemSize;
        const row = Math.floor(index / NUM_COLUMNS);
        return {
            length: size,
            offset: row * (size + GAP),
            index,
        };
    }, [itemSize]);

    if (isLoading) {
        return (
            <View className="items-center justify-center p-8">
                <Spinner />
            </View>
        );
    }

    if (videoItems.length === 0) {
        return (
            <EmptyState
                title={t('profile.videos.empty.title', { defaultValue: 'No videos yet' })}
                customIcon={<Video size={48} className="text-muted-foreground" />}
                containerStyle={{ flex: 1 }}
            />
        );
    }

    return (
        <View
            className="w-full"
            onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
        >
            <FlatList
                data={videoItems}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                numColumns={NUM_COLUMNS}
                scrollEnabled={false}
                nestedScrollEnabled={false}
                getItemLayout={getItemLayout}
                removeClippedSubviews
                contentContainerStyle={{ gap: GAP, paddingHorizontal: H_PADDING }}
                columnWrapperStyle={{ gap: GAP }}
            />
        </View>
    );
};

export default VideosGrid;
