import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View,
    StyleSheet,
    RefreshControl,
} from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useLocalSearchParams } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { FlashList } from '@shopify/flash-list';
import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { feedService } from '@/services/feedService';
import PostItem from '@/components/Feed/PostItem';
import { FeedResponse } from '@mention/shared-types';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { createScopedLogger } from '@/lib/logger';
import SEO from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { Ionicons } from '@expo/vector-icons';

const logger = createScopedLogger('TrendScreen');

const TrendScreen: React.FC = () => {
    const { name, description, type } = useLocalSearchParams<{
        name: string;
        description?: string;
        type?: string;
    }>();
    const theme = useTheme();
    const safeBack = useSafeBack();
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const { handleScroll, scrollEventThrottle, registerScrollable } = useLayoutScroll();

    const topicName = name || '';
    const topicDescription = description || '';
    const topicType = type || 'topic';

    const [posts, setPosts] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(true);
    const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
    const flatListRef = useRef<any>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);

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
        if (!topicName) return;

        try {
            if (isRefresh) {
                setRefreshing(true);
            } else if (cursor) {
                setLoadingMore(true);
            } else {
                setLoading(true);
            }
            setError(null);

            const response: FeedResponse = await feedService.getPostsByTopic(topicName, {
                type: 'posts',
                cursor,
                limit: 20,
            });

            if (isRefresh || !cursor) {
                setPosts(response.items || []);
            } else {
                setPosts(prev => {
                    const existingIds = new Set(prev.map(p => p.id || p._id));
                    const newPosts = (response.items || []).filter(
                        p => !existingIds.has(p.id || p._id)
                    );
                    return [...prev, ...newPosts];
                });
            }

            setHasMore(response.hasMore || false);
            setNextCursor(response.nextCursor);
        } catch (err: any) {
            const errorMessage = err?.message || 'Failed to load posts';
            logger.error('Error fetching topic posts', err);
            setError(errorMessage);
        } finally {
            setLoading(false);
            setRefreshing(false);
            setLoadingMore(false);
        }
    }, [topicName]);

    useEffect(() => {
        if (topicName) {
            fetchPosts();
        }
    }, [topicName]);

    const handleRefresh = useCallback(() => {
        fetchPosts(undefined, true);
    }, [fetchPosts]);

    const handleLoadMore = useCallback(() => {
        if (!loadingMore && hasMore && nextCursor) {
            fetchPosts(nextCursor);
        }
    }, [loadingMore, hasMore, nextCursor, fetchPosts]);

    const handleBack = useCallback(() => {
        safeBack();
    }, []);

    const renderItem = useCallback(({ item }: { item: any }) => {
        return <PostItem post={item} />;
    }, []);

    const typeLabel = topicType === 'entity'
        ? t('trend.typeEntity', { defaultValue: 'Entity' })
        : t('trend.typeTopic', { defaultValue: 'Topic' });

    const renderHeader = () => (
        <View className="p-4 pb-2" style={{ paddingTop: insets.top }}>
            <ThemedText className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1 font-primary">
                {t('trend.trendingLabel', { defaultValue: `Trending ${typeLabel}` })}
            </ThemedText>
            <ThemedText type="title" className="text-[28px] font-bold mb-1 font-primary">
                {topicName}
            </ThemedText>
            {topicDescription ? (
                <ThemedText className="text-sm text-muted-foreground font-primary mb-1">
                    {topicDescription}
                </ThemedText>
            ) : null}
            {posts.length > 0 && (
                <ThemedText className="text-sm text-muted-foreground font-primary">
                    {t('trend.postCount', { count: posts.length, defaultValue: `${posts.length} posts` })}
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
            <EmptyState
                title={t('trend.noPosts', { defaultValue: 'No posts found' })}
                subtitle={t('trend.noPostsMessage', {
                    defaultValue: `No posts have been found for this topic yet.`,
                    topic: topicName,
                })}
                customIcon={
                    <Ionicons
                        name="trending-up-outline"
                        size={48}
                        className="text-muted-foreground"
                        color={theme.colors.textSecondary}
                    />
                }
            />
        );
    };

    const headerContent = (
        <Header
            options={{
                title: topicName,
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
    );

    if (error && !loading) {
        return (
            <SafeAreaView className="flex-1" edges={['top', 'bottom']}>
                <SEO
                    title={t('seo.trend.title', { topic: topicName, defaultValue: `${topicName} - Mention` })}
                    description={t('seo.trend.description', {
                        topic: topicName,
                        defaultValue: `Posts about ${topicName} on Mention`,
                    })}
                />
                {headerContent}
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
                title={t('seo.trend.title', { topic: topicName, defaultValue: `${topicName} - Mention` })}
                description={t('seo.trend.description', {
                    topic: topicName,
                    defaultValue: `Posts about ${topicName} on Mention`,
                })}
            />
            {headerContent}
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

export default TrendScreen;
