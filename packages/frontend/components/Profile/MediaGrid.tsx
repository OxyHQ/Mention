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
import { getCachedFileDownloadUrlSync, videoPosterUrl } from '@/utils/imageUrlCache';
import { isDbAvailable } from '@/db';
import VideoPosterCell from '@/components/common/VideoPosterCell';
import { isVideoMediaRef } from '@/utils/mediaTypes';

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
const CAROUSEL_ICON_SIZE = 12;
const PROFILE_MEDIA_FEED_LIMIT = 50;
const PROFILE_POSTS_FEED_LIMIT = 60;
const INITIAL_RENDER_COUNT = 18;
const WINDOW_SIZE = 7;

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

    // Grid image thumbnail. Prefer the server-resolved final `thumbUrl` (fallback
    // `url`) from the media object; fall back to the legacy client resolver for a
    // raw id/url string (old cached responses without the new fields).
    const resolveImageUri = useCallback(
        (ref?: string | { thumbUrl?: string; url?: string; id?: string }): string | undefined => {
            if (!ref) return undefined;
            if (typeof ref !== 'string') {
                const serverUrl = ref.thumbUrl || ref.url;
                if (serverUrl) return serverUrl;
            }
            const path = typeof ref === 'string' ? ref : (ref.id || ref.url);
            if (!path) return undefined;
            const resolved = getCachedFileDownloadUrlSync(oxyServices, path, 'thumb');
            return resolved || undefined;
        },
        [oxyServices]
    );

    // Static video poster. Prefer the server-resolved final `posterUrl` (fallback
    // `thumbUrl`); fall back to the legacy client resolver for a raw id/url string.
    // Undefined → icon placeholder; a 404/error from the URL is handled by the
    // cell's own image-error fallback.
    const resolveVideoPosterUri = useCallback(
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

    const mediaItems = useMemo<MediaGridEntry[]>(() => {
        const out: MediaGridEntry[] = [];
        const items = (mediaFeed?.items?.length ? mediaFeed.items : (postsFeed?.items || [])) as any[];

        // A media reference is either a raw id/url string (legacy) or a media
        // object carrying the server-resolved final URLs (`url`/`thumbUrl`/`posterUrl`).
        type MediaRef = string | { id?: string; url?: string; src?: string; path?: string; thumbUrl?: string; posterUrl?: string };

        const pickIdOrUrl = (x: any): string | undefined => {
            if (!x) return undefined;
            if (typeof x === 'string') return x;
            return x.id || x.url || x.src || x.path || undefined;
        };

        const pushUris = (targetId: string, sources: (MediaRef | undefined)[], postType?: string, mediaTypes?: (string | undefined)[]) => {
            const collected = sources.filter(Boolean) as MediaRef[];
            const seen = new Set<string>();

            collected.forEach((ref, idx) => {
                // Dedup/video-detection key is the raw id/url; resolution reads the
                // object's server URLs first (handled inside the resolvers).
                const key = pickIdOrUrl(ref);
                if (!key) return;
                const isVideo = isVideoMediaRef(key, { postType, mediaType: mediaTypes?.[idx] });

                // For videos the cell renders a static poster; an empty/unresolvable
                // poster still produces a placeholder cell, so a video entry is always
                // valid. Images require a resolvable uri.
                if (seen.has(key)) return;
                seen.add(key);

                if (isVideo) {
                    const posterUri = resolveVideoPosterUri(ref);
                    const isCarousel = collected.length > 1;
                    out.push({ postId: targetId, uri: posterUri ?? '', isVideo: true, isCarousel, mediaIndex: idx });
                    return;
                }

                const uri = resolveImageUri(ref);
                if (!uri) return;
                const isCarousel = collected.length > 1;
                out.push({ postId: targetId, uri, isVideo: false, isCarousel, mediaIndex: idx });
            });
        };

        const extractFrom = (post: any, targetId: string) => {
            const postType = post?.type;
            // Prefer the content.media objects: they carry the server-resolved final
            // URLs (url/thumbUrl/posterUrl). Fall back to normalized id arrays only
            // when the objects are absent (old cached responses).
            const mediaArray: any[] = Array.isArray(post?.content?.media) ? post.content.media : [];
            if (mediaArray.length) {
                const mediaTypes = mediaArray.map((m: any) => (typeof m === 'object' && m.type) ? m.type : undefined);
                pushUris(targetId, mediaArray, postType, mediaTypes);
                return;
            }

            const normalized = (post?.allMediaIds && post.allMediaIds.length)
                ? post.allMediaIds
                : (post?.mediaIds || []);
            if (normalized?.length) {
                pushUris(targetId, normalized, postType);
                return;
            }
            // Fallback to legacy structures
            const collected: MediaRef[] = [];
            const collectedTypes: (string | undefined)[] = [];
            const pushFromArray = (arr?: any[], options: { fromMedia?: boolean; fromAttachments?: boolean } = {}) => {
                if (!Array.isArray(arr) || !arr.length) return;
                arr.forEach((m) => {
                    if (options.fromAttachments && typeof m === 'object') {
                        if (m.type !== 'media' || !m.id) return;
                    }

                    if (!pickIdOrUrl(m)) return;

                    // Keep the object so server URLs survive; strings pass through.
                    collected.push(m);

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
                    <VideoPosterCell
                        posterUri={item.uri || undefined}
                        size={itemSize}
                        placeholderColor={theme.colors.textSecondary}
                        badge="center"
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
