import React from 'react';
import { FlatList, ListRenderItemInfo, RefreshControl, StyleSheet } from 'react-native';
import Post from '../Post';
import CreatePost from '../Post/CreatePost';
import { useFeed, FeedType } from '@/hooks/useFeed';

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

    return (
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
        />
    );
};

const styles = StyleSheet.create({
    container: {
        paddingBottom: 20,
    },
});

export default Feed;
