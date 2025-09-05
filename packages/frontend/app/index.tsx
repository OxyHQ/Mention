import React, { useCallback, useState } from 'react';
import {
    View,
    StyleSheet,
    TouchableOpacity,
    Text,
    Image
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useOxy } from '@oxyhq/services';
import Feed from '../components/Feed/Feed';
import { Header } from '../components/Header';
import { colors } from '../styles/colors';
import { usePostsStore } from '../stores/postsStore';

const MainFeedScreen = () => {
    const { user, isAuthenticated } = useOxy();
    const { savePost, unsavePost } = usePostsStore();
    const [activeTab, setActiveTab] = useState<'for_you' | 'following'>('for_you');

    // Debug authentication state
    console.log('🔐 MainFeedScreen - isAuthenticated:', isAuthenticated, 'user:', user?.id);


    const handleSavePress = useCallback(async (postId: string) => {
        try {
            console.log('💾 Save button pressed for postId:', postId);

            const { feeds } = usePostsStore.getState();
            const post = feeds.posts.items.find(p => p.id === postId) ||
                feeds.mixed.items.find(p => p.id === postId);

            console.log('📄 Found post:', post?.id, 'isSaved:', post?.isSaved);

            if (post?.isSaved) {
                console.log('🗑️ Unsaving post...');
                await unsavePost({ postId });
            } else {
                console.log('💾 Saving post...');
                await savePost({ postId });
            }
        } catch (error) {
            console.error('❌ Error toggling save:', error);
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
        <SafeAreaView edges={['top']}>
            <View style={styles.container}>
                <StatusBar style="dark" />

                {/* Header */}
                <Header
                    options={{
                        title: 'Mention',
                        rightComponents: [
                            <TouchableOpacity key="search" style={styles.headerButton} onPress={() => router.push('/search')}>
                                <Ionicons name="search-outline" size={24} color={colors.COLOR_BLACK_LIGHT_3} />
                            </TouchableOpacity>,
                            <TouchableOpacity key="notifications" style={styles.headerButton} onPress={() => router.push('/notifications')}>
                                <Ionicons name="notifications-outline" size={24} color={colors.COLOR_BLACK_LIGHT_3} />
                            </TouchableOpacity>,
                            <TouchableOpacity key="profile" style={styles.headerButton} onPress={() => router.push('/profile')}>
                                <Image
                                    source={{ uri: user?.avatar || 'https://via.placeholder.com/32' }}
                                    style={styles.headerAvatar}
                                />
                            </TouchableOpacity>
                        ]
                    }}
                />

                {/* Tab Navigation */}
                <View style={styles.tabContainer}>
                    {renderTabButton('for_you', 'For You', 'home-outline')}
                    {renderTabButton('following', 'Following', 'people-outline')}
                </View>

                {/* Feed */}
                <Feed
                    type={activeTab as any}
                    onSavePress={handleSavePress}
                />

                {/* Floating Action Button */}
                <TouchableOpacity style={styles.fab} onPress={handleComposePress}>
                    <Ionicons name="add" size={24} color={colors.COLOR_BLACK_LIGHT_9} />
                </TouchableOpacity>
            </View>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
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
