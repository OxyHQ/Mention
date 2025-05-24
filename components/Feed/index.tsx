import React from 'react';
import { FlatList, ListRenderItemInfo, RefreshControl, StyleSheet, Text, View } from 'react-native';
import Post from '../Post';
import CreatePost from '../Post/CreatePost';
import { useFeed, FeedType } from '@/hooks/useFeed';
import ErrorBoundary from '../ErrorBoundary';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';

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

    // Render each post item
    const renderItem = ({ item }: ListRenderItemInfo<any>) => {
        return <Post postData={item} />;
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

    return (
        <ErrorBoundary>
            <FlatList
                data={posts}
                keyExtractor={(item) => item.id}
                renderItem={renderItem}
                onEndReached={fetchMore}
                onEndReachedThreshold={0.5}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
                contentContainerStyle={styles.container}
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
            />
        </ErrorBoundary>
    );
};

const styles = StyleSheet.create({
    container: {
        paddingBottom: 20,
    },
    errorContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
    },
    errorText: {
        fontSize: 16,
        marginBottom: 10,
        textAlign: 'center',
    },
    retryText: {
        color: colors.primaryColor,
        fontSize: 16,
        fontWeight: '600',
    },
    emptyContainer: {
        padding: 20,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_3,
    }
});

export default Feed;
