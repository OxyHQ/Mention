import React, { useEffect } from 'react';
import { FlatList, ListRenderItemInfo, RefreshControl, StyleSheet, Text, View, ActivityIndicator, useWindowDimensions, Platform } from 'react-native';
import Post from '../Post';
import CreatePost from '../Post/CreatePost';
import { useFeed, FeedType } from '@/hooks/useFeed';
import ErrorBoundary from '../ErrorBoundary';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import LoadingSkeleton from './LoadingSkeleton';
import { useOxy } from '@oxyhq/services/full';

interface FeedProps {
    type?: FeedType;
    parentId?: string;
    showCreatePost?: boolean;
    onCreatePostPress?: () => void;
}

const Feed: React.FC<FeedProps> = ({
    type = 'all',
    parentId,
    showCreatePost = false,
    onCreatePostPress
}) => {
    const { isAuthenticated } = useOxy();
    const feedType = type === 'home' && !isAuthenticated ? 'all' : type;
    const {
        posts,
        loading,
        refreshing,
        error,
        hasMore,
        fetchMore,
        refresh
    } = useFeed({ type: feedType, parentId });

    const { t } = useTranslation();
    const { width: windowWidth } = useWindowDimensions();

    // Calculate responsive values
    const isTabletOrDesktop = windowWidth >= 768;
    
    // Refresh feed when component mounts
    useEffect(() => {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, parentId]);

    // Render each post item
    const renderItem = ({ item, index }: ListRenderItemInfo<any>) => {
        return (
            <View style={[
                styles.postItemContainer,
                isTabletOrDesktop && styles.postItemContainerTablet
            ]}>
                <Post postData={item} />
            </View>
        );
    };

    // Handle create post press
    const handleCreatePostPress = () => {
        if (onCreatePostPress) {
            onCreatePostPress();
        }
    };

    // Render error state
    if (error) {
        // If the error is about missing auth and user is not authenticated, show sign-in prompt
        if ((error.toLowerCase().includes('authorization') || error.toLowerCase().includes('auth')) && !isAuthenticated && type === 'home') {
            return (
                <View style={styles.errorContainer}>
                    <Text style={styles.errorText}>{t('Sign in to view your personalized feed.')}</Text>
                </View>
            );
        }
        return (
            <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
                <Text style={styles.retryText} onPress={refresh}>{t('Tap to retry')}</Text>
            </View>
        );
    }

    // Render initial loading state
    if (loading && posts.length === 0 && !refreshing) {
        return (
            <View style={styles.loadingContainer}>
                <LoadingSkeleton count={3} />
            </View>
        );
    }

    return (
        <ErrorBoundary>
            <FlatList
                data={posts}
                keyExtractor={(item) => item.id}
                renderItem={renderItem}
                onEndReached={fetchMore}
                onEndReachedThreshold={0.5}
                refreshControl={<RefreshControl 
                    refreshing={refreshing} 
                    onRefresh={refresh}
                    colors={[colors.primaryColor]} 
                    tintColor={colors.primaryColor}
                />}
                contentContainerStyle={[
                    styles.container,
                    isTabletOrDesktop && styles.containerTablet,
                    posts.length === 0 && styles.emptyListContainer
                ]}
                ListHeaderComponent={isAuthenticated && showCreatePost ? (
                    <CreatePost 
                        onPress={handleCreatePostPress}
                        placeholder={t("What's happening?")} 
                    />
                ) : null}
                ListEmptyComponent={
                    !loading ? (
                        <View style={styles.emptyContainer}>
                            <Text style={styles.emptyText}>
                                {type === 'following' 
                                    ? t('No posts from people you follow yet')
                                    : t('No posts available')}
                            </Text>
                        </View>
                    ) : null
                }
                ListFooterComponent={
                    loading && posts.length > 0 ? (
                        <View style={styles.footerLoaderContainer}>
                            <ActivityIndicator color={colors.primaryColor} size="small" />
                        </View>
                    ) : null
                }
                ItemSeparatorComponent={() => (
                    <View style={styles.separator} />
                )}
                showsVerticalScrollIndicator={false}
            />
        </ErrorBoundary>
    );
};

const styles = StyleSheet.create({
    container: {
        paddingBottom: 20,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
        minHeight: '100%'
    },
    containerTablet: {
        paddingHorizontal: Platform.OS === 'web' ? '10%' : 16,
    },
    errorContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
    errorText: {
        fontSize: 16,
        marginBottom: 10,
        textAlign: 'center',
        color: colors.COLOR_BLACK_LIGHT_3,
    },
    retryText: {
        color: colors.primaryColor,
        fontSize: 16,
        fontWeight: '600',
    },
    emptyContainer: {
        padding: 20,
        alignItems: 'center',
        backgroundColor: 'white',
        borderRadius: 8,
        margin: 16,
        shadowColor: colors.shadow,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: 1,
    },
    emptyText: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_3,
        textAlign: 'center'
    },
    loadingContainer: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
        padding: 16
    },
    separator: {
        height: 6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
    footerLoaderContainer: {
        padding: 20,
        alignItems: 'center',
    },
    postItemContainer: {
        backgroundColor: 'white',
        borderRadius: 8,
        overflow: 'hidden',
        shadowColor: colors.shadow,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.2,
        shadowRadius: 3,
        elevation: 2,
    },
    postItemContainerTablet: {
        borderRadius: 12,
        shadowRadius: 4,
        elevation: 3,
    },
    emptyListContainer: {
        paddingVertical: 16
    }
});

export default Feed;
