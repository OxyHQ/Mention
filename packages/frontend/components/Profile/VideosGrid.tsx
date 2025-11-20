import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Dimensions,
    FlatList,
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
import { EmptyState } from '@/components/common/EmptyState';

interface VideosGridProps {
    userId?: string;
    isPrivate?: boolean;
    isOwnProfile?: boolean;
}

const NUM_COLUMNS = 3;
const GAP = 1;
const H_PADDING = 0;

const VideosGrid: React.FC<VideosGridProps> = ({ userId, isPrivate, isOwnProfile }) => {
    const { oxyServices } = useOxy();
    const router = useRouter();
    const theme = useTheme();
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
        
        fetchUserFeed(userId, { type: 'media', limit: 50 });
    }, [userId, fetchUserFeed, isPrivate, isOwnProfile]);

    useEffect(() => {
        if (!userId || (isPrivate && !isOwnProfile)) return;
        
            const isLoaded = !!mediaFeed && !mediaFeed.isLoading;
            const isEmpty = (mediaFeed?.items?.length || 0) === 0;
            const postsLoaded = !!postsFeed;
        
            if (isLoaded && isEmpty && !postsLoaded) {
            fetchUserFeed(userId, { type: 'posts', limit: 60 });
            }
    }, [userId, mediaFeed, mediaFeed?.isLoading, mediaFeed?.items?.length, postsFeed, fetchUserFeed, isPrivate, isOwnProfile]);

    const resolveVideoUri = useCallback(
        (path?: string): string | undefined => {
            if (!path) return undefined;
            if (/^https?:\/\//i.test(path)) return path;
            try {
                return (oxyServices as any)?.getFileDownloadUrl?.(path, 'full') ?? path;
            } catch {
                return path;
            }
        },
        [oxyServices]
    );

    const videoItems = useMemo(() => {
        const out: { postId: string; uri: string; mediaIndex: number }[] = [];
        const items = (mediaFeed?.items?.length ? mediaFeed.items : (postsFeed?.items || [])) as any[];

        const pickIdOrUrl = (x: any): string | undefined => {
            if (!x) return undefined;
            if (typeof x === 'string') return x;
            return x.id || x.url || x.src || x.path || undefined;
        };

        const pushVideoUris = (targetId: string, sources: (string | undefined)[], postType?: string, mediaTypes?: (string | undefined)[]) => {
            const collected = sources.filter(Boolean) as string[];
            const seen = new Set<string>();
            const isPostVideo = postType === 'video';
            
            collected.forEach((raw, idx) => {
                const mediaType = mediaTypes?.[idx];
                const isMediaTypeVideo = mediaType === 'video';
                const isFileExtensionVideo = /\.(mp4|mov|m4v|webm|mpg|mpeg|avi|mkv)$/i.test(String(raw));
                const isVideo = isPostVideo || isMediaTypeVideo || isFileExtensionVideo;
                
                if (!isVideo) return; // Only include videos
                
                const uri = resolveVideoUri(raw);
                if (!uri || seen.has(uri)) return;
                seen.add(uri);
                out.push({ postId: targetId, uri, mediaIndex: idx });
            });
        };

        const extractFrom = (post: any, targetId: string) => {
            const postType = post?.type || post?.content?.type;
            const media = post?.content?.media || [];
            const mediaTypes = media.map((m: any) => m?.type);

            if (media.length > 0) {
                const uris = media.map((m: any) => pickIdOrUrl(m.id || m.url || m.src || m.path));
                pushVideoUris(targetId, uris, postType, mediaTypes);
            } else if (post?.videoUrl || post?.video) {
                pushVideoUris(targetId, [pickIdOrUrl(post.videoUrl || post.video)], postType);
            }
        };

        items.forEach((post: any) => {
            const id = post?.id || post?._id || post?.postId;
            if (!id) return;
            extractFrom(post, String(id));
        });

        return out;
    }, [mediaFeed?.items, postsFeed?.items, resolveVideoUri]);

    const isLoading = (mediaFeed?.isLoading || postsFeed?.isLoading) && videoItems.length === 0;

    const renderItem = useCallback(({ item }: { item: { postId: string; uri: string; mediaIndex: number } }) => {
        const handlePress = () => {
            router.push(`/videos?postId=${item.postId}`);
        };

        return (
            <TouchableOpacity
                activeOpacity={0.8}
                style={[styles.gridItem, { width: itemSize, height: itemSize }]}
                onPress={handlePress}
            >
                <VideoGridItem 
                    uri={item.uri} 
                    itemSize={itemSize} 
                    backgroundColor={theme.colors.backgroundSecondary}
                />
            </TouchableOpacity>
        );
    }, [itemSize, router, theme.colors.backgroundSecondary]);

    const VideoGridItem: React.FC<{ uri: string; itemSize: number; backgroundColor: string }> = ({ uri, itemSize, backgroundColor }) => {
        const player = useVideoPlayer(uri, (player) => {
            if (player) {
                player.loop = true;
                player.muted = true;
            }
        });

        useEffect(() => {
            if (player) {
                player.play();
            }
            return () => {
                if (player) {
                    player.pause();
                }
            };
        }, [player]);

        return (
            <View style={{ width: itemSize, height: itemSize, backgroundColor, overflow: 'hidden' }}>
                {player ? (
                    <VideoView
                        player={player}
                        style={{ width: '100%', height: '100%' }}
                        contentFit="cover"
                        nativeControls={false}
                        allowsFullscreen={false}
                        allowsPictureInPicture={false}
                    />
                ) : (
                    <View style={[styles.videoPlaceholder, { backgroundColor }]}>
                        <Ionicons name="videocam-outline" size={24} color={theme.colors.textSecondary} />
                    </View>
                )}
                <View style={styles.playIcon}>
                    <Ionicons name="play" size={16} color="white" />
                </View>
            </View>
        );
    };

    const keyExtractor = useCallback((it: { postId: string; uri: string; mediaIndex?: number }, index: number) => 
        `${it.postId}:${it.mediaIndex ?? index}`, []);

    const getItemLayout = useCallback((_: any, index: number) => {
        const size = itemSize;
        return {
            length: size,
            offset: size * index,
            index,
        };
    }, [itemSize]);

    if (isLoading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
            </View>
        );
    }

    if (videoItems.length === 0) {
        return (
            <EmptyState
                title="No videos yet"
                icon={{
                    name: 'videocam-outline',
                    size: 48,
                }}
                containerStyle={styles.emptyContainer}
            />
        );
    }

    return (
        <View 
            style={styles.container}
            onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
        >
            <FlatList
                data={videoItems}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                numColumns={NUM_COLUMNS}
                scrollEnabled={false}
                getItemLayout={getItemLayout}
                removeClippedSubviews
                contentContainerStyle={styles.grid}
                columnWrapperStyle={NUM_COLUMNS > 1 ? { gap: GAP } : undefined}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        width: '100%',
    },
    grid: {
        paddingHorizontal: H_PADDING,
    },
    gridItem: {
        marginRight: GAP,
        marginBottom: GAP,
    },
    videoPlaceholder: {
        width: '100%',
        height: '100%',
        justifyContent: 'center',
        alignItems: 'center',
    },
    playIcon: {
        position: 'absolute',
        top: 4,
        right: 4,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        borderRadius: 12,
        width: 24,
        height: 24,
        justifyContent: 'center',
        alignItems: 'center',
    },
    loadingContainer: {
        padding: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyContainer: {
        flex: 1,
    },
});

export default VideosGrid;

