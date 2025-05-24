import React from 'react';
import { FlatList, ListRenderItemInfo, RefreshControl, StyleSheet, Text, View, ActivityIndicator, useWindowDimensions, Platform } from 'react-native';
import Post from '../Post';
import CreatePost from '../Post/CreatePost';
import { useFeed, FeedType } from '@/hooks/useFeed';
import ErrorBoundary from '../ErrorBoundary';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import LoadingSkeleton from './LoadingSkeleton';

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
    const {
        posts,
        loading,
        refreshing,
        error,
        hasMore,
        fetchMore,
        refresh
    } = useFeed({ type, parentId });

    const { t } = useTranslation();
    const { width: windowWidth } = useWindowDimensions();

    // Calculate responsive values
    const isTabletOrDesktop = windowWidth >= 768;

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
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
                contentContainerStyle={[
                    styles.container,
                    isTabletOrDesktop && styles.containerTablet
                ]}
                ListHeaderComponent={showCreatePost ? (
                    <CreatePost onPress={handleCreatePostPress} />
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
    },
    emptyText: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_3,
    },
    loadingContainer: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
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
        borderRadius: 4,
        overflow: 'hidden',
        shadowColor: colors.shadow,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.2,
        shadowRadius: 2,
        elevation: 2,
    },
    postItemContainerTablet: {
        borderRadius: 8,
        shadowRadius: 4,
        elevation: 3,
    }
});

export default Feed;
