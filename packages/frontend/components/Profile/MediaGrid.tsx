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
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import { isDbAvailable } from '@/db';

interface MediaGridProps {
    userId?: string;
    isPrivate?: boolean;
    isOwnProfile?: boolean;
}

interface MediaGridEntry {
    postId: string;
    uri: string;
    isVideo: boolean;
    isCarousel: boolean;
    mediaIndex: number;
}

const NUM_COLUMNS = 3;
const GAP = 1; // instagram-like tight spacing
const H_PADDING = 0;
const VIDEO_PLAY_ICON_SIZE = 24;
const VIDEO_PLACEHOLDER_ICON_SIZE = 32;
const CAROUSEL_ICON_SIZE = 12;
const PROFILE_MEDIA_FEED_LIMIT = 50;
const PROFILE_POSTS_FEED_LIMIT = 60;
const INITIAL_RENDER_COUNT = 18;
const WINDOW_SIZE = 7;

/**
 * Static video cell for the media grid: a paused poster image (Oxy `thumb`
 * variant) plus a play badge. No live `useVideoPlayer`/`VideoView` — playback
 * happens only in the fullscreen reels screen on tap. Hoisted + memoized so
 * cells never remount on parent re-render.
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
                        <Ionicons name="videocam-outline" size={VIDEO_PLACEHOLDER_ICON_SIZE} color={placeholderColor} />
                    </View>
                )}
                <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: 'rgba(0, 0, 0, 0.2)' }}>
                    <Ionicons name="play-circle" size={VIDEO_PLAY_ICON_SIZE} color="rgba(255, 255, 255, 0.9)" />
                </View>
            </View>
        );
    }
);
VideoGridCell.displayName = 'VideoGridCell';

const MediaGrid: React.FC<MediaGridProps> = ({ userId, isPrivate, isOwnProfile }) => {
    const { oxyServices } = useAuth();
    const router = useRouter();
    const theme = useTheme();
    const { t } = useTranslation();
    const { fetchUserFeed } = usePostsStore();
    const getPostFromDb = usePostsStore((s) => s.getPostFromDb);
    const mediaFeed = useUserFeedSelector(userId || '', 'media');
    const postsFeed = useUserFeedSelector(userId || '', 'posts');
    // Non-scrollable grid inside parent ScrollView; pull-to-refresh handled by parent
    const [containerWidth, setContainerWidth] = useState<number>(Dimensions.get('window').width);
    const itemSize = useMemo(() => {
        const totalGap = GAP * (NUM_COLUMNS - 1) + H_PADDING * 2;
        return Math.floor((containerWidth - totalGap) / NUM_COLUMNS);
    }, [containerWidth]);

    useEffect(() => {
        if (!userId || (isPrivate && !isOwnProfile)) return;

        fetchUserFeed(userId, { type: 'media', limit: PROFILE_MEDIA_FEED_LIMIT });
    }, [userId, fetchUserFeed, isPrivate, isOwnProfile]);

    // Fallback: if media feed finished and is empty, attempt to load posts feed for media extraction
    useEffect(() => {
        if (!userId || (isPrivate && !isOwnProfile)) return;

        const isLoaded = !!mediaFeed && !mediaFeed.isLoading;
        const isEmpty = (mediaFeed?.items?.length || 0) === 0;
        const postsLoaded = !!postsFeed;

        if (isLoaded && isEmpty && !postsLoaded) {
            fetchUserFeed(userId, { type: 'posts', limit: PROFILE_POSTS_FEED_LIMIT });
        }
    }, [userId, mediaFeed, mediaFeed?.isLoading, mediaFeed?.items?.length, postsFeed, fetchUserFeed, isPrivate, isOwnProfile]);

    // Images use the `thumb` variant (grid-sized). Videos resolve their `thumb`
    // variant too — an Oxy-generated static poster image (zero live decoders).
    // Federated/absolute http URLs pass through unchanged via the cache helper.
    const resolveImageUri = useCallback(
        (path?: string): string | undefined => {
            if (!path) return undefined;
            const resolved = getCachedFileDownloadUrlSync(oxyServices, path, 'thumb');
            return resolved || undefined;
        },
        [oxyServices]
    );

    const resolveVideoPosterUri = useCallback(
        (path?: string): string | undefined => {
            if (!path) return undefined;
            // Federated video: no generated thumb variant — fall back to placeholder.
            if (/^https?:\/\//i.test(path)) return undefined;
            const resolved = getCachedFileDownloadUrlSync(oxyServices, path, 'thumb');
            return resolved && resolved !== path ? resolved : undefined;
        },
        [oxyServices]
    );

    const mediaItems = useMemo<MediaGridEntry[]>(() => {
        const out: MediaGridEntry[] = [];
        const items = (mediaFeed?.items?.length ? mediaFeed.items : (postsFeed?.items || [])) as any[];

        const pickIdOrUrl = (x: any): string | undefined => {
            if (!x) return undefined;
            if (typeof x === 'string') return x;
            return x.id || x.url || x.src || x.path || undefined;
        };

        const pushUris = (targetId: string, sources: (string | undefined)[], postType?: string, mediaTypes?: (string | undefined)[]) => {
            const collected = sources.filter(Boolean) as string[];
            const seen = new Set<string>();
            const isPostVideo = postType === 'video';

            collected.forEach((raw, idx) => {
                const mediaType = mediaTypes?.[idx];
                const isMediaTypeVideo = mediaType === 'video';
                const isFileExtensionVideo = /\.(mp4|mov|m4v|webm|mpg|mpeg|avi|mkv)$/i.test(String(raw));
                const isVideo = isPostVideo || isMediaTypeVideo || isFileExtensionVideo;

                // For videos the cell renders a static poster (resolved via `thumb`);
                // an empty/unresolvable poster still produces a placeholder cell, so
                // a video entry is always valid. Images require a resolvable uri.
                if (seen.has(raw)) return;
                seen.add(raw);

                if (isVideo) {
                    const posterUri = resolveVideoPosterUri(raw);
                    const isCarousel = collected.length > 1;
                    out.push({ postId: targetId, uri: posterUri ?? '', isVideo: true, isCarousel, mediaIndex: idx });
                    return;
                }

                const uri = resolveImageUri(raw);
                if (!uri) return;
                const isCarousel = collected.length > 1;
                out.push({ postId: targetId, uri, isVideo: false, isCarousel, mediaIndex: idx });
            });
        };

        const extractFrom = (post: any, targetId: string) => {
            const postType = post?.type;
            // Prefer normalized allMediaIds/mediaIds from backend
            const normalized = (post?.allMediaIds && post.allMediaIds.length)
                ? post.allMediaIds
                : (post?.mediaIds || []);

            // Get media types if available from content.media array
            const mediaArray = post?.content?.media || [];
            const mediaTypes = mediaArray.map((m: any) => {
                if (typeof m === 'object' && m.type) return m.type;
                return undefined;
            });

            if (normalized?.length) {
                pushUris(targetId, normalized, postType, mediaTypes);
                return;
            }
            // Fallback to legacy structures
            const collected: string[] = [];
            const collectedTypes: (string | undefined)[] = [];
            const pushFromArray = (arr?: any[], options: { fromMedia?: boolean; fromAttachments?: boolean } = {}) => {
                if (!Array.isArray(arr) || !arr.length) return;
                arr.forEach((m) => {
                    if (options.fromAttachments && typeof m === 'object') {
                        if (m.type !== 'media' || !m.id) return;
                    }

                    const raw = pickIdOrUrl(m);
                    if (!raw) return;

                    collected.push(raw);

                    if (typeof m === 'object') {
                        if (options.fromAttachments && m.mediaType) {
                            collectedTypes.push(m.mediaType);
                        } else if (options.fromMedia && m.type) {
                            collectedTypes.push(m.type);
                        } else {
                            collectedTypes.push(undefined);
                        }
                    } else {
                        collectedTypes.push(undefined);
                    }
                });
            };
            pushFromArray(post?.content?.media, { fromMedia: true });
            pushFromArray(post?.content?.images);
            pushFromArray(post?.content?.attachments, { fromAttachments: true });
            pushFromArray(post?.content?.files);
            pushFromArray(post?.media);
            pushUris(targetId, collected, postType, collectedTypes.length > 0 ? collectedTypes : undefined);
        };

        for (const p of items) {
            extractFrom(p, String(p.id));

            const hasOwnMedia = !!(p?.allMediaIds?.length || p?.mediaIds?.length);
            if (hasOwnMedia) continue;

            // Boosted/quoted media: the transformed feed item already carries the
            // related post objects (`original` / `quoted` / `boost.originalPost`).
            // Use those first — they work on web (no SQLite). On native we can also
            // fall back to the SQLite cache when the embedded object is absent.
            const embeddedOriginal = p?.original ?? p?.quoted ?? p?.boost?.originalPost ?? null;
            if (embeddedOriginal) {
                extractFrom(embeddedOriginal, String(p.id));
                continue;
            }

            const origId = p?.originalPostId || p?.boostOf || p?.quoteOf;
            if (origId && isDbAvailable()) {
                const orig = getPostFromDb(String(origId));
                if (orig) extractFrom(orig, String(p.id));
            }
        }

        return out;
    }, [mediaFeed?.items, postsFeed?.items, resolveImageUri, resolveVideoPosterUri, getPostFromDb]);

    const gridItemStyle = useMemo(() => ({
        width: itemSize,
        height: itemSize,
    }), [itemSize]);

    const imageStyle = useMemo(() => ({
        width: '100%' as const,
        height: '100%' as const,
    }), []);

    const renderItem = useCallback(({ item }: { item: MediaGridEntry }) => {
        const handlePress = () => {
            if (item.isVideo) {
                router.push(`/videos?postId=${item.postId}`);
            } else {
                router.push(`/p/${item.postId}`);
            }
        };

        return (
            <TouchableOpacity
                activeOpacity={0.8}
                style={gridItemStyle}
                onPress={handlePress}
            >
                {item.isVideo ? (
                    <VideoGridCell
                        posterUri={item.uri || undefined}
                        size={itemSize}
                        placeholderColor={theme.colors.textSecondary}
                    />
                ) : (
                    <Image
                        source={{ uri: item.uri }}
                        className="bg-secondary"
                        style={imageStyle}
                        contentFit="cover"
                        transition={150}
                        cachePolicy="memory-disk"
                    />
                )}
                {item.isCarousel && (
                    <View
                        className="absolute top-1 right-1 rounded p-0.5"
                        style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
                    >
                        <Ionicons name="albums-outline" size={CAROUSEL_ICON_SIZE} color="white" />
                    </View>
                )}
            </TouchableOpacity>
        );
    }, [itemSize, router, gridItemStyle, imageStyle, theme.colors.textSecondary]);

    const keyExtractor = useCallback((it: MediaGridEntry, index: number) => `${it.postId}:${it.mediaIndex ?? index}`, []);

    const getItemLayout = useCallback((_: ArrayLike<MediaGridEntry> | null | undefined, index: number) => {
        const size = itemSize;
        const row = Math.floor(index / NUM_COLUMNS);
        const length = size;
        const offset = row * (size + GAP);
        return { length, offset, index };
    }, [itemSize]);

    // Loading state first; if no items yet and feeds are still loading, show spinner
    const isLoading = (!mediaFeed && !postsFeed) || mediaFeed?.isLoading || postsFeed?.isLoading;
    if (isLoading && mediaItems.length === 0) {
        return (
            <View className="items-center justify-center p-8">
                <Spinner />
            </View>
        );
    }

    if (!isLoading && mediaItems.length === 0) {
        return (
            <EmptyState
                title={t('profile.media.empty.title', { defaultValue: 'No media posts yet' })}
                subtitle={t('profile.media.empty.subtitle', { defaultValue: 'Photos and videos you share will appear here.' })}
                icon={{
                    name: 'images-outline',
                    size: 48,
                }}
                containerStyle={{ flex: 1 }}
            />
        );
    }

    return (
        <View className="bg-background" onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}>
            <FlatList
                data={mediaItems}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                numColumns={NUM_COLUMNS}
                columnWrapperStyle={{ gap: GAP }}
                contentContainerStyle={{ gap: GAP, paddingHorizontal: H_PADDING }}
                showsVerticalScrollIndicator={false}
                scrollEnabled={false}
                nestedScrollEnabled={false}
                removeClippedSubviews
                initialNumToRender={INITIAL_RENDER_COUNT}
                windowSize={WINDOW_SIZE}
                getItemLayout={getItemLayout}
            />
        </View>
    );
};

export default MediaGrid;
