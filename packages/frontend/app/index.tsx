import React, { useState, useEffect, useCallback } from 'react';
import { SafeAreaView, StyleSheet, View, TouchableOpacity, Text, Platform, ScrollView, RefreshControl, Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import { useOxy } from '@oxyhq/services';
import { router } from 'expo-router';
import { Feed, PostAction } from '../components/Feed/index';
import { usePostsStore } from '../stores/postsStore';
import { Ionicons } from '@expo/vector-icons';

type TabType = 'for-you' | 'following' | 'custom';

const HomeScreen: React.FC = () => {
    const [activeTab, setActiveTab] = useState<TabType>('for-you');
    const [refreshing, setRefreshing] = useState(false);
    const { t } = useTranslation();
    const { isAuthenticated, user } = useOxy();
    const { posts, replies, reposts, fetchFeed, isLoading } = usePostsStore();

    useEffect(() => {
        // Set default tab based on authentication
        if (isAuthenticated) {
            setActiveTab('for-you');
        } else {
            setActiveTab('for-you'); // Show explore feed for unauthenticated users
        }

        // Fetch initial feed data
        fetchFeed({
            type: 'mixed',
            limit: 20
        });
    }, [isAuthenticated, fetchFeed]);

    const handlePostAction = (action: PostAction, postId: string) => {
        console.log(`${action} action for post ${postId}`);
        // Post actions are handled by the Feed component and store
    };

    const handleMediaPress = (imageUrl: string, index: number) => {
        console.log(`Media pressed: ${imageUrl} at index ${index}`);
        // TODO: Implement media viewer with modal or navigation
        // For now, just show an alert
        Alert.alert('Media Viewer', `Viewing media at index ${index}`);
    };

    const onRefresh = useCallback(() => {
        setRefreshing(true);
        // Fetch fresh data from backend
        fetchFeed({
            type: 'mixed',
            limit: 20
        }).finally(() => {
            setRefreshing(false);
        });
    }, [fetchFeed]);

    const getFeedData = () => {
        if (activeTab === 'custom') {
            return { data: [], type: 'posts' as const };
        }

        if (activeTab === 'following' && isAuthenticated && user) {
            // For following tab, show posts from users the current user follows
            // For now, just show all posts (in a real app, you'd filter by following)
            return { data: posts, type: 'posts' as const };
        } else if (activeTab === 'for-you') {
            // For "For You" tab, show a mix of posts, replies, and reposts
            const allContent = [
                ...posts,
                ...replies,
                ...reposts
            ].sort((a, b) => {
                // Sort by date (newest first)
                const dateA = new Date(a.date).getTime();
                const dateB = new Date(b.date).getTime();
                return dateB - dateA;
            });

            return { data: allContent, type: 'mixed' as const };
        }

        return { data: posts, type: 'posts' as const };
    };

    const renderFeedContent = () => {
        if (activeTab === 'custom') {
            return (
                <View style={styles.customFeedContainer}>
                    <Text style={styles.customFeedText}>Custom Feed</Text>
                    <Text style={styles.customFeedSubtext}>Coming soon...</Text>
                </View>
            );
        }

        const { data, type } = getFeedData();

        return (
            <ScrollView
                style={styles.feedContainer}
                showsVerticalScrollIndicator={false}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        tintColor={colors.primaryColor}
                        colors={[colors.primaryColor]}
                    />
                }
            >
                <Feed
                    data={data}
                    type={type}
                    onPostAction={handlePostAction}
                    onMediaPress={handleMediaPress}
                    isLoading={refreshing || isLoading}
                />
            </ScrollView>
        );
    };

    return (
        <SafeAreaView style={styles.container}>
            {/* Enhanced Tab Navigation */}
            <View style={styles.tabsContainer}>
                <TouchableOpacity
                    style={[styles.tab, activeTab === 'for-you' && styles.activeTab]}
                    onPress={() => setActiveTab('for-you')}
                >
                    <Text style={[styles.tabText, activeTab === 'for-you' && styles.activeTabText]}>
                        {t('For You')}
                    </Text>
                </TouchableOpacity>

                {isAuthenticated && (
                    <TouchableOpacity
                        style={[styles.tab, activeTab === 'following' && styles.activeTab]}
                        onPress={() => setActiveTab('following')}
                    >
                        <Text style={[styles.tabText, activeTab === 'following' && styles.activeTabText]}>
                            {t('Following')}
                        </Text>
                    </TouchableOpacity>
                )}

                <TouchableOpacity
                    style={[styles.tab, activeTab === 'custom' && styles.activeTab]}
                    onPress={() => setActiveTab('custom')}
                >
                    <Text style={[styles.tabText, activeTab === 'custom' && styles.activeTabText]}>
                        🔧 {t('Custom')}
                    </Text>
                </TouchableOpacity>
            </View>

            {/* Feed Content */}
            {renderFeedContent()}

            {/* FAB for creating new posts */}
            <TouchableOpacity
                style={styles.fab}
                onPress={() => router.push('/compose')}
            >
                <Ionicons name="add" size={24} color="#FFF" />
            </TouchableOpacity>
        </SafeAreaView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
    tabsContainer: {
        flexDirection: 'row',
        backgroundColor: 'white',
        borderBottomWidth: 0.5,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        shadowColor: colors.shadow,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: Platform.OS === 'android' ? 2 : 0,
    },
    tab: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 16,
        paddingHorizontal: 8,
    },
    activeTab: {
        borderBottomWidth: 3,
        borderBottomColor: colors.primaryColor,
    },
    tabText: {
        fontSize: 15,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_3,
        textAlign: 'center',
    },
    activeTabText: {
        color: colors.primaryColor,
        fontWeight: 'bold',
    },
    feedContainer: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
    customFeedContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
    customFeedText: {
        fontSize: 18,
        color: colors.COLOR_BLACK_LIGHT_3,
        fontWeight: '600',
    },
    customFeedSubtext: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 8,
    },
    fab: {
        position: 'absolute',
        bottom: 40,
        right: 20,
        width: 56,
        height: 56,
        borderRadius: 28,
        zIndex: 1000,
        backgroundColor: colors.primaryColor,
        alignItems: 'center',
        justifyContent: 'center',
        elevation: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
    },
});

export default HomeScreen;