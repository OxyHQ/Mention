import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Dimensions,
    FlatList,
    TouchableOpacity,
    View,
} from 'react-native';
import { Image } from 'expo-image';
import { Spinner } from '@/components/ui/Spinner';
import { useRouter } from 'expo-router';
import { useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { usePostsStore, useUserFeedSelector } from '@/stores/postsStore';
import { Ionicons } from '@expo/vector-icons';
import { EmptyState } from '@/components/common/EmptyState';
import { Video } from '@/assets/icons/video-icon';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';

interface VideosGridProps {
    userId?: string;
    isPrivate?: boolean;
    isOwnProfile?: boolean;
}

interface VideoGridEntry {
    postId: string;
    /** Static poster URL (Oxy `thumb` variant) when resolvable; undefined for federated/unknown sources. */
    posterUri?: string;
    mediaIndex: number;
}

const NUM_COLUMNS = 3;
const GAP = 1;
const H_PADDING = 0;
const PLAY_BADGE_SIZE = 24;
const PLAY_BADGE_RADIUS = 12;
const PLAY_ICON_SIZE = 16;
const PLACEHOLDER_ICON_SIZE = 24;
const PROFILE_VIDEO_FEED_LIMIT = 50;
const PROFILE_POSTS_FEED_LIMIT = 60;

/**
 * A single grid cell. Renders a STATIC poster image (no live decoder) plus a
 * play badge — this is a thumbnail grid (Instagram-style); playback happens
 * only in the fullscreen reels screen on tap. Hoisted to module scope and
 * memoized so cells never remount on parent re-render.
 */
const VideoGridCell = React.memo<{ posterUri?: string; size: number; placeholderColor: string }>(
    ({ posterUri, size, placeholderColor }) => {
        const containerStyle = useMemo(
            () => ({ width: size, height: size, overflow: 'hidden' as const }),
            [size]
        );

        return (
            <View className="bg-secondary" style={containerStyle}>
                {posterUri ? (
                    <Image
                        source={{ uri: posterUri }}
                        style={{ width: '100%', height: '100%' }}
                        contentFit="cover"
                        transition={150}
                        cachePolicy="memory-disk"
                    />
                ) : (
                    <View className="w-full h-full items-center justify-center bg-secondary">
                        <Ionicons name="videocam-outline" size={PLACEHOLDER_ICON_SIZE} color={placeholderColor} />
                    </View>
                )}
                <View
                    className="absolute top-1 right-1 items-center justify-center"
                    style={{
                        backgroundColor: 'rgba(0, 0, 0, 0.6)',
                        borderRadius: PLAY_BADGE_RADIUS,
                        width: PLAY_BADGE_SIZE,
                        height: PLAY_BADGE_SIZE,
                    }}
                >
                    <Ionicons name="play" size={PLAY_ICON_SIZE} color="white" />
                </View>
            </View>
        );
    }
);
VideoGridCell.displayName = 'VideoGridCell';

const VideosGrid: React.FC<VideosGridProps> = ({ userId, isPrivate, isOwnProfile }) => {
    const { oxyServices } = useAuth();
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
    }, [userId, fetchUserFeed, isPrivate, isOwnProfile]);

    useEffect(() => {
        if (!userId || (isPrivate && !isOwnProfile)) return;

        const isLoaded = !!mediaFeed && !mediaFeed.isLoading;
        const isEmpty = (mediaFeed?.items?.length || 0) === 0;
        const postsLoaded = !!postsFeed;

        if (isLoaded && isEmpty && !postsLoaded) {
            fetchUserFeed(userId, { type: 'posts', limit: PROFILE_POSTS_FEED_LIMIT });
        }
    }, [userId, mediaFeed, mediaFeed?.isLoading, mediaFeed?.items?.length, postsFeed, fetchUserFeed, isPrivate, isOwnProfile]);

    /**
     * Resolve a static poster URL for a video media reference. For an Oxy asset
     * id we request the `thumb` variant (a generated image poster — zero live
     * decoders). For federated/absolute http URLs there is no thumb variant, so
     * we return undefined and fall back to the icon placeholder.
     */
    const resolvePosterUri = useCallback(
        (path?: string): string | undefined => {
            if (!path) return undefined;
            if (/^https?:\/\//i.test(path)) return undefined;
            const resolved = getCachedFileDownloadUrlSync(oxyServices, path, 'thumb');
            return resolved && resolved !== path ? resolved : undefined;
        },
        [oxyServices]
    );

    const videoItems = useMemo<VideoGridEntry[]>(() => {
        const out: VideoGridEntry[] = [];
        const items = (mediaFeed?.items?.length ? mediaFeed.items : (postsFeed?.items || [])) as any[];

        const pickIdOrUrl = (x: any): string | undefined => {
            if (!x) return undefined;
            if (typeof x === 'string') return x;
            return x.id || x.url || x.src || x.path || undefined;
        };

        const pushVideoSources = (
            targetId: string,
            sources: (string | undefined)[],
            postType?: string,
            mediaTypes?: (string | undefined)[]
        ) => {
            const collected = sources.filter(Boolean) as string[];
            const seen = new Set<string>();
            const isPostVideo = postType === 'video';

            collected.forEach((raw, idx) => {
                const mediaType = mediaTypes?.[idx];
                const isMediaTypeVideo = mediaType === 'video';
                const isFileExtensionVideo = /\.(mp4|mov|m4v|webm|mpg|mpeg|avi|mkv)$/i.test(String(raw));
                const isVideo = isPostVideo || isMediaTypeVideo || isFileExtensionVideo;

                if (!isVideo) return; // Only include videos
                if (seen.has(raw)) return;
                seen.add(raw);
                out.push({ postId: targetId, posterUri: resolvePosterUri(raw), mediaIndex: idx });
            });
        };

        const extractFrom = (post: any, targetId: string) => {
            const postType = post?.type || post?.content?.type;
            const media = post?.content?.media || [];
            const mediaTypes = media.map((m: any) => m?.type);

            if (media.length > 0) {
                const uris = media.map((m: any) => pickIdOrUrl(m.id || m.url || m.src || m.path));
                pushVideoSources(targetId, uris, postType, mediaTypes);
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

    const renderItem = useCallback(({ item }: { item: VideoGridEntry }) => {
        const handlePress = () => {
            router.push(`/videos?postId=${item.postId}`);
        };

        return (
            <TouchableOpacity
                activeOpacity={0.8}
                style={{ width: itemSize, height: itemSize, marginRight: GAP, marginBottom: GAP }}
                onPress={handlePress}
            >
                <VideoGridCell
                    posterUri={item.posterUri}
                    size={itemSize}
                    placeholderColor={theme.colors.textSecondary}
                />
            </TouchableOpacity>
        );
    }, [itemSize, router, theme.colors.textSecondary]);

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
                contentContainerStyle={{ paddingHorizontal: H_PADDING }}
                columnWrapperStyle={NUM_COLUMNS > 1 ? { gap: GAP } : undefined}
            />
        </View>
    );
};

export default VideosGrid;
