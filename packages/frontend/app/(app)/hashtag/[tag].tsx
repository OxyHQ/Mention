import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View,
    StyleSheet,
    RefreshControl,
} from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { useLocalSearchParams, router } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { feedService } from '@/services/feedService';
import PostItem from '@/components/Feed/PostItem';
import { FeedResponse } from '@mention/shared-types';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { createScopedLogger } from '@/utils/logger';
import SEO from '@/components/SEO';
import { FeedEmptyState } from '@/components/Feed/FeedEmptyState';

const logger = createScopedLogger('HashtagScreen');

const HashtagScreen: React.FC = () => {
    const { tag } = useLocalSearchParams<{ tag: string }>();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const { handleScroll, scrollEventThrottle, registerScrollable } = useLayoutScroll();

    // Remove # if present
    const hashtag = tag?.replace(/^#/, '') || '';
    const displayTag = `#${hashtag}`;

    const [posts, setPosts] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(true);
    const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
    const flatListRef = useRef<any>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);

    // Register scrollable with LayoutScrollContext
    useEffect(() => {
        if (flatListRef.current) {
            unregisterScrollableRef.current = registerScrollable(flatListRef.current);
        }
        return () => {
            if (unregisterScrollableRef.current) {
                unregisterScrollableRef.current();
                unregisterScrollableRef.current = null;
            }
        };
    }, [registerScrollable]);

    const fetchPosts = useCallback(async (cursor?: string, isRefresh = false) => {
        if (!hashtag) return;

        try {
            if (isRefresh) {
                setRefreshing(true);
            } else if (cursor) {
                setLoadingMore(true);
            } else {
                setLoading(true);
            }
            setError(null);

            const response: FeedResponse = await feedService.getPostsByHashtag(hashtag, {
                type: 'posts',
                cursor,
                limit: 20,
            });

            if (isRefresh || !cursor) {
                setPosts(response.items || []);
            } else {
                // Deduplicate new posts against existing
                const existingIds = new Set(posts.map(p => p.id || p._id));
                const newPosts = (response.items || []).filter(
                    p => !existingIds.has(p.id || p._id)
                );
                setPosts(prev => [...prev, ...newPosts]);
            }

            setHasMore(response.hasMore || false);
            setNextCursor(response.nextCursor);
        } catch (err: any) {
            const errorMessage = err?.message || 'Failed to load posts';
            logger.error('Error fetching hashtag posts', err);
            setError(errorMessage);
        } finally {
            setLoading(false);
            setRefreshing(false);
            setLoadingMore(false);
        }
    }, [hashtag, posts]);

    useEffect(() => {
        if (hashtag) {
            fetchPosts();
        }
    }, [hashtag]);

    const handleRefresh = useCallback(() => {
        fetchPosts(undefined, true);
    }, [fetchPosts]);

    const handleLoadMore = useCallback(() => {
        if (!loadingMore && hasMore && nextCursor) {
            fetchPosts(nextCursor);
        }
    }, [loadingMore, hasMore, nextCursor, fetchPosts]);

    const handleBack = useCallback(() => {
        router.back();
    }, []);

    const renderItem = useCallback(({ item }: { item: any }) => {
        return <PostItem post={item} />;
    }, []);

    const renderHeader = () => (
        <View className="p-4 pb-2" style={{ paddingTop: insets.top }}>
            <ThemedText type="title" className="text-[28px] font-bold mb-1 font-primary">
                {displayTag}
            </ThemedText>
            {posts.length > 0 && (
                <ThemedText className="text-sm text-muted-foreground font-primary">
                    {t('hashtag.postCount', { count: posts.length, defaultValue: `${posts.length} posts` })}
                </ThemedText>
            )}
        </View>
    );

    const renderFooter = () => {
        if (!loadingMore) return null;
        return (
            <View className="p-4 items-center">
                <Loading size="small" style={{ flex: undefined }} />
            </View>
        );
    };

    const renderEmpty = () => {
        if (loading) return null;
        return (
            <FeedEmptyState
                title={t('hashtag.noPosts', { defaultValue: 'No posts found' })}
                message={t('hashtag.noPostsMessage', {
                    defaultValue: `No posts have been tagged with ${displayTag} yet.`,
                    hashtag: displayTag
                })}
            />
        );
    };

    if (error && !loading) {
        return (
            <SafeAreaView className="flex-1" edges={['top', 'bottom']}>
                <SEO
                    title={t('seo.hashtag.title', { hashtag: displayTag, defaultValue: `${displayTag} - Mention` })}
                    description={t('seo.hashtag.description', {
                        hashtag: displayTag,
                        defaultValue: `Posts tagged with ${displayTag} on Mention`
                    })}
                />
                <Header
                    options={{
                        title: displayTag,
                        leftComponents: [
                            <IconButton
                                key="back"
                                variant="icon"
                                onPress={handleBack}
                            >
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                />
                <ThemedView className="flex-1 justify-center items-center p-5">
                    <ThemedText type="subtitle" className="text-center">
                        {error}
                    </ThemedText>
                </ThemedView>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView className="flex-1" edges={['top', 'bottom']}>
            <SEO
                title={t('seo.hashtag.title', { hashtag: displayTag, defaultValue: `${displayTag} - Mention` })}
                description={t('seo.hashtag.description', {
                    hashtag: displayTag,
                    defaultValue: `Posts tagged with ${displayTag} on Mention`
                })}
            />
            <Header
                options={{
                    title: displayTag,
                    leftComponents: [
                        <IconButton
                            key="back"
                            variant="icon"
                            onPress={handleBack}
                        >
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                }}
            />
            {loading && posts.length === 0 ? (
                <ThemedView className="flex-1 justify-center items-center">
                    <Loading size="large" />
                </ThemedView>
            ) : (
                <FlashList
                    ref={flatListRef}
                    data={posts}
                    renderItem={renderItem}
                    keyExtractor={(item, index) => item.id || item._id || `post-${index}`}
                    estimatedItemSize={200}
                    onEndReached={handleLoadMore}
                    onEndReachedThreshold={0.5}
                    ListHeaderComponent={renderHeader}
                    ListFooterComponent={renderFooter}
                    ListEmptyComponent={renderEmpty}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={handleRefresh}
                            tintColor={theme.colors.primary}
                        />
                    }
                    onScroll={handleScroll}
                    scrollEventThrottle={scrollEventThrottle}
                    contentContainerStyle={styles.listContent}
                />
            )}
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    listContent: {
        paddingBottom: 20,
    },
});

export default HashtagScreen;
