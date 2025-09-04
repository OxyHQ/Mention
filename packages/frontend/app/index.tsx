import React, { useCallback, useState } from 'react';
import {
    View,
    StyleSheet,
    TouchableOpacity,
    Text,
    SafeAreaView,
    StatusBar,
    Image
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import Feed from '../components/Feed';
import { colors } from '../styles/colors';
import { usePostsStore } from '../stores/postsStore';

const MainFeedScreen = () => {
    const { user } = useOxy();
    const { savePost, unsavePost } = usePostsStore();
    const [activeTab, setActiveTab] = useState<'mixed' | 'posts' | 'media' | 'replies' | 'reposts'>('mixed');

    const handlePostPress = useCallback((postId: string) => {
        // Navigate to post detail
        router.push(`/p/${postId}`);
    }, []);

    const handleUserPress = useCallback((username: string) => {
        // Navigate to user profile
        router.push(`/@${username}`);
    }, []);

    const handleReplyPress = useCallback((postId: string) => {
        // Navigate to reply screen
        router.push(`/reply?postId=${postId}`);
    }, []);

    const handleRepostPress = useCallback((postId: string) => {
        // Navigate to repost screen
        router.push(`/repost?postId=${postId}`);
    }, []);

    const handleLikePress = useCallback((postId: string) => {
        // Handle like action
        console.log('Like post:', postId);
    }, []);

    const handleSharePress = useCallback((postId: string) => {
        // Handle share action
        console.log('Share post:', postId);
    }, []);

    const handleSavePress = useCallback(async (postId: string) => {
        try {
            const { feeds } = usePostsStore.getState();
            const post = feeds.posts.items.find(p => p.id === postId) ||
                feeds.mixed.items.find(p => p.id === postId);

            if (post?.isSaved) {
                await unsavePost({ postId });
            } else {
                await savePost({ postId });
            }
        } catch (error) {
            console.error('Error toggling save:', error);
        }
    }, [savePost, unsavePost]);

    const handleComposePress = useCallback(() => {
        // Navigate to compose screen
        router.push('/compose');
    }, []);

    const renderTabButton = (tab: typeof activeTab, label: string, icon: string) => (
        <TouchableOpacity
            style={[styles.tabButton, activeTab === tab && styles.activeTabButton]}
            onPress={() => setActiveTab(tab)}
        >
            <Ionicons
                name={icon as any}
                size={20}
                color={activeTab === tab ? colors.primaryColor : colors.COLOR_BLACK_LIGHT_4}
            />
            <Text style={[styles.tabLabel, activeTab === tab && styles.activeTabLabel]}>
                {label}
            </Text>
        </TouchableOpacity>
    );

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            <StatusBar style="dark" />

            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    <Text style={styles.headerTitle}>Mention</Text>
                </View>

                <View style={styles.headerRight}>
                    <TouchableOpacity style={styles.headerButton} onPress={() => router.push('/search')}>
                        <Ionicons name="search-outline" size={24} color={colors.COLOR_BLACK_LIGHT_3} />
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.headerButton} onPress={() => router.push('/notifications')}>
                        <Ionicons name="notifications-outline" size={24} color={colors.COLOR_BLACK_LIGHT_3} />
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.headerButton} onPress={() => router.push('/profile')}>
                        <Image
                            source={{ uri: user?.avatar || 'https://via.placeholder.com/32' }}
                            style={styles.headerAvatar}
                        />
                    </TouchableOpacity>
                </View>
            </View>

            {/* Tab Navigation */}
            <View style={styles.tabContainer}>
                {renderTabButton('mixed', 'For You', 'home-outline')}
                {renderTabButton('posts', 'Posts', 'document-text-outline')}
                {renderTabButton('media', 'Media', 'image-outline')}
                {renderTabButton('replies', 'Replies', 'chatbubble-outline')}
                {renderTabButton('reposts', 'Reposts', 'repeat-outline')}
            </View>

            {/* Feed */}
            <Feed
                type={activeTab}
                onPostPress={handlePostPress}
                onUserPress={handleUserPress}
                onReplyPress={handleReplyPress}
                onRepostPress={handleRepostPress}
                onLikePress={handleLikePress}
                onSharePress={handleSharePress}
                onSavePress={handleSavePress}
            />

            {/* Floating Action Button */}
            <TouchableOpacity style={styles.fab} onPress={handleComposePress}>
                <Ionicons name="add" size={24} color={colors.COLOR_BLACK_LIGHT_9} />
            </TouchableOpacity>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    headerLeft: {
        flex: 1,
    },
    headerTitle: {
        fontSize: 24,
        fontWeight: '700',
        color: colors.primaryColor,
    },
    headerRight: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    headerButton: {
        padding: 8,
        marginLeft: 8,
    },
    headerAvatar: {
        width: 32,
        height: 32,
        borderRadius: 16,
    },
    tabContainer: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
    tabButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 16,
        paddingHorizontal: 8,
    },
    activeTabButton: {
        borderBottomWidth: 2,
        borderBottomColor: colors.primaryColor,
    },
    tabLabel: {
        marginLeft: 6,
        fontSize: 14,
        fontWeight: '500',
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    activeTabLabel: {
        color: colors.primaryColor,
        fontWeight: '600',
    },
    fab: {
        position: 'absolute',
        bottom: 24,
        right: 24,
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: colors.primaryColor,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 8,
        shadowColor: colors.shadow,
        shadowOffset: {
            width: 0,
            height: 4,
        },
        shadowOpacity: 0.3,
        shadowRadius: 8,
    },
});

export default MainFeedScreen;