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
     * Resolve a static poster URL for a video media reference. Oxy asset ids
     * resolve to the generated `thumb` variant (zero live decoders); federated /
     * absolute http URLs resolve to the backend `/media/poster` frame extractor.
     * Undefined → icon placeholder. A 404/error from the poster endpoint is
     * handled by the cell's own image-error fallback.
     */
    const resolvePosterUri = useCallback(
        (path?: string): string | undefined => videoPosterUrl(path ?? '', oxyServices),
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

            collected.forEach((raw, idx) => {
                const isVideo = isVideoMediaRef(raw, { postType, mediaType: mediaTypes?.[idx] });

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
                <VideoPosterCell
                    posterUri={item.posterUri}
                    size={itemSize}
                    placeholderColor={theme.colors.textSecondary}
                    badge="corner"
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
