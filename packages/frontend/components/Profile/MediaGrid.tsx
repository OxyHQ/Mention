import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
    FlatList,
    Image,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import { useTheme } from '@/hooks/useTheme';
import { usePostsStore, useUserFeedSelector } from '@/stores/postsStore';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';

interface MediaGridProps {
    userId?: string;
}

const NUM_COLUMNS = 3;
const GAP = 1; // instagram-like tight spacing
const H_PADDING = 0;

const MediaGrid: React.FC<MediaGridProps> = ({ userId }) => {
    const { oxyServices } = useOxy();
    const router = useRouter();
    const theme = useTheme();
    const { fetchUserFeed, postsById } = usePostsStore();
    const mediaFeed = useUserFeedSelector(userId || '', 'media');
    const postsFeed = useUserFeedSelector(userId || '', 'posts');
    // Non-scrollable grid inside parent ScrollView; pull-to-refresh handled by parent
    const [containerWidth, setContainerWidth] = useState<number>(Dimensions.get('window').width);
    const itemSize = useMemo(() => {
        const totalGap = GAP * (NUM_COLUMNS - 1) + H_PADDING * 2;
        return Math.floor((containerWidth - totalGap) / NUM_COLUMNS);
    }, [containerWidth]);

    useEffect(() => {
        const load = async () => {
            if (!userId) return;
            await fetchUserFeed(userId, { type: 'media', limit: 50 });
        };
        load();
        return () => { };
    }, [userId, fetchUserFeed]);

    // Fallback: if media feed finished and is empty, attempt to load posts feed for media extraction
    useEffect(() => {
        const maybeFallback = async () => {
            if (!userId) return;
            const isLoaded = !!mediaFeed && !mediaFeed.isLoading;
            const isEmpty = (mediaFeed?.items?.length || 0) === 0;
            const postsLoaded = !!postsFeed;
            if (isLoaded && isEmpty && !postsLoaded) {
                await fetchUserFeed(userId, { type: 'posts', limit: 60 });
            }
        };
        maybeFallback();
    }, [userId, mediaFeed, mediaFeed?.isLoading, mediaFeed?.items?.length, postsFeed, fetchUserFeed]);

    const resolveImageUri = useCallback(
        (path?: string): string | undefined => {
            if (!path) return undefined;
            if (/^https?:\/\//i.test(path)) return path;
            try {
                // Fallback to Oxy file download if path is an asset key
                return (oxyServices as any)?.getFileDownloadUrl?.(path, 'thumb') ?? path;
            } catch {
                return path;
            }
        },
        [oxyServices]
    );

    const resolveVideoUri = useCallback(
        (path?: string): string | undefined => {
            if (!path) return undefined;
            if (/^https?:\/\//i.test(path)) return path;
            try {
                // For videos, use full resolution instead of thumb
                return (oxyServices as any)?.getFileDownloadUrl?.(path, 'full') ?? path;
            } catch {
                return path;
            }
        },
        [oxyServices]
    );

    const mediaItems = useMemo(() => {
        const out: ({ postId: string; uri: string; isVideo: boolean; isCarousel: boolean; mediaIndex: number } | null)[] = [];
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
                
                const uri = isVideo ? resolveVideoUri(raw) : resolveImageUri(raw);
                // Allow duplicates across different posts; only avoid duplicates within the same post
                if (!uri || seen.has(uri)) return;
                seen.add(uri);
                const isCarousel = collected.length > 1;
                out.push({ postId: targetId, uri, isVideo, isCarousel, mediaIndex: idx });
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
            const pushFromArray = (arr?: any[], isMediaArray = false) => {
                if (!Array.isArray(arr) || !arr.length) return;
                arr.forEach((m) => {
                    const raw = pickIdOrUrl(m);
                    if (raw) {
                        collected.push(raw);
                        if (isMediaArray && typeof m === 'object' && m.type) {
                            collectedTypes.push(m.type);
                        } else {
                            collectedTypes.push(undefined);
                        }
                    }
                });
            };
            pushFromArray(post?.content?.media, true);
            pushFromArray(post?.content?.images);
            pushFromArray(post?.content?.attachments);
            pushFromArray(post?.content?.files);
            pushFromArray(post?.media);
            pushUris(targetId, collected, postType, collectedTypes.length > 0 ? collectedTypes : undefined);
        };

        for (const p of (items || []) as any[]) {
            extractFrom(p, String(p.id));
            const origId = p?.originalPostId || p?.repostOf || p?.quoteOf;
            if (origId && (!p?.allMediaIds?.length && !p?.mediaIds?.length)) {
                const orig = postsById?.[String(origId)];
                if (orig) extractFrom(orig, String(p.id));
            }
        }

        return out.filter(Boolean) as { postId: string; uri: string; isVideo: boolean; isCarousel: boolean; mediaIndex: number }[];
    }, [mediaFeed?.items, postsFeed?.items, resolveImageUri, resolveVideoUri, postsById]);

    // Refresh handled outside by parent feed/scroll

    // Note: Grid is rendered inside ProfileScreen's outer ScrollView; keep FlatList non-scrollable

    // Video grid item component
    const VideoGridItem: React.FC<{ uri: string; itemSize: number; backgroundColor: string }> = ({ uri, itemSize, backgroundColor }) => {
        const [hasError, setHasError] = useState(false);
        
        const player = useVideoPlayer(uri || '', (player) => {
            if (player && uri) {
                player.loop = true;
                player.muted = true;
                // Don't auto-play immediately - let it load first
                // player.play();
            }
        });

        // Auto-play when component mounts (if video is ready)
        useEffect(() => {
            if (player && uri && !hasError) {
                const playVideo = async () => {
                    try {
                        await player.play();
                    } catch (error) {
                        setHasError(true);
                    }
                };
                playVideo();
            }
        }, [player, uri, hasError]);

        if (hasError || !uri) {
            return (
                <View style={{ width: itemSize, height: itemSize, backgroundColor, justifyContent: 'center', alignItems: 'center' }}>
                    <Ionicons name="videocam-outline" size={32} color={theme.colors.textSecondary} />
                    <View style={styles.videoOverlay}>
                        <Ionicons name="play-circle" size={24} color="rgba(255, 255, 255, 0.9)" />
                    </View>
                </View>
            );
        }

        return (
            <View style={{ width: itemSize, height: itemSize, backgroundColor, overflow: 'hidden' }}>
                <VideoView
                    player={player}
                    style={{ width: '100%', height: '100%' }}
                    contentFit="cover"
                    nativeControls={false}
                    allowsFullscreen={false}
                    onError={() => setHasError(true)}
                />
                <View style={styles.videoOverlay}>
                    <Ionicons name="play-circle" size={24} color="rgba(255, 255, 255, 0.9)" />
                </View>
            </View>
        );
    };

    const renderItem = useCallback(({ item }: { item: { postId: string; uri: string; isVideo: boolean; isCarousel: boolean; mediaIndex: number } }) => {
        const handlePress = () => {
            if (item.isVideo) {
                // Navigate to videos screen for videos
                router.push(`/videos?postId=${item.postId}`);
            } else {
                // Navigate to post for images
                router.push(`/p/${item.postId}`);
            }
        };

        return (
            <TouchableOpacity
                activeOpacity={0.8}
                style={{ width: itemSize, height: itemSize }}
                onPress={handlePress}
            >
                {item.isVideo ? (
                    <VideoGridItem 
                        uri={item.uri} 
                        itemSize={itemSize} 
                        backgroundColor={theme.colors.backgroundSecondary}
                    />
                ) : (
                    <Image
                        source={{ uri: item.uri }}
                        style={{ width: '100%', height: '100%', backgroundColor: theme.colors.backgroundSecondary }}
                        resizeMode="cover"
                    />
                )}
                {item.isCarousel && (
                    <View style={styles.carouselIndicator}>
                        <Ionicons name="albums-outline" size={12} color="white" />
                    </View>
                )}
            </TouchableOpacity>
        );
    }, [itemSize, router, theme.colors.backgroundSecondary]);

    const keyExtractor = useCallback((it: { postId: string; uri: string; mediaIndex?: number }, index: number) => `${it.postId}:${it.mediaIndex ?? index}`, []);

    const getItemLayout = useCallback((_: any, index: number) => {
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
            <View style={styles.loading}>
                <ActivityIndicator color={theme.colors.primary} />
            </View>
        );
    }

    if (!isLoading && mediaItems.length === 0) {
        return (
            <View style={styles.empty}>
                <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>No media posts yet</Text>
                <Text style={[styles.emptySub, { color: theme.colors.textSecondary }]}>Photos and videos you share will appear here.</Text>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.background }]} onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}>
            <FlatList
                data={mediaItems}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                numColumns={NUM_COLUMNS}
                columnWrapperStyle={{ gap: GAP }}
                contentContainerStyle={{ gap: GAP, paddingHorizontal: H_PADDING }}
                showsVerticalScrollIndicator={false}
                scrollEnabled={false}
                removeClippedSubviews
                initialNumToRender={18}
                windowSize={7}
                getItemLayout={getItemLayout}
            />
        </View>
    );
};

export default MediaGrid;

const styles = StyleSheet.create({
    container: {
        // backgroundColor set dynamically via theme
    },
    loading: {
        paddingVertical: 24,
    },
    empty: {
        alignItems: 'center',
        paddingVertical: 40,
        gap: 8,
    },
    emptyTitle: {
        fontSize: 18,
        fontWeight: '700',
        // color set dynamically via theme
    },
    emptySub: {
        fontSize: 14,
        // color set dynamically via theme
    },
    videoOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.2)',
    },
    carouselIndicator: {
        position: 'absolute',
        top: 4,
        right: 4,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        borderRadius: 4,
        padding: 2,
    },
});
