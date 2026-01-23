import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    RefreshControl,
    ActivityIndicator,
} from 'react-native';
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
        <View style={[styles.headerContent, { paddingTop: insets.top }]}>
            <ThemedText type="title" style={styles.hashtagTitle}>
                {displayTag}
            </ThemedText>
            {posts.length > 0 && (
                <ThemedText style={[styles.postCount, { color: theme.colors.textSecondary }]}>
                    {t('hashtag.postCount', { count: posts.length, defaultValue: `${posts.length} posts` })}
                </ThemedText>
            )}
        </View>
    );

    const renderFooter = () => {
        if (!loadingMore) return null;
        return (
            <View style={styles.footer}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
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
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
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
                                <BackArrowIcon size={20} color={theme.colors.text} />
                            </IconButton>,
                        ],
                    }}
                />
                <ThemedView style={styles.errorContainer}>
                    <ThemedText type="subtitle" style={styles.errorText}>
                        {error}
                    </ThemedText>
                </ThemedView>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
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
                            <BackArrowIcon size={20} color={theme.colors.text} />
                        </IconButton>,
                    ],
                }}
            />
            {loading && posts.length === 0 ? (
                <ThemedView style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
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
    container: {
        flex: 1,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    listContent: {
        paddingBottom: 20,
    },
    headerContent: {
        padding: 16,
        paddingBottom: 8,
    },
    hashtagTitle: {
        fontSize: 28,
        fontWeight: 'bold',
        marginBottom: 4,
    },
    postCount: {
        fontSize: 14,
    },
    footer: {
        padding: 16,
        alignItems: 'center',
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    errorText: {
        textAlign: 'center',
    },
});

export default HashtagScreen;













