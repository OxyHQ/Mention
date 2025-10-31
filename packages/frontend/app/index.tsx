import React, { useState, useEffect, useMemo } from 'react';
import { StyleSheet, View, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import Feed from '../components/Feed/Feed';
import { useOxy } from '@oxyhq/services';
import { getData } from '@/utils/storage';
import { customFeedsService } from '@/services/customFeedsService';
import AnimatedTabBar from '../components/common/AnimatedTabBar';
import { useTheme } from '@/hooks/useTheme';
import { useHomeRefresh } from '@/context/HomeRefreshContext';

type HomeTab = 'for_you' | 'following' | 'trending' | string;

interface PinnedFeed {
    id: string;
    title: string;
    feedId: string;
}

const PINNED_KEY = 'mention.pinnedFeeds';

const HomeScreen: React.FC = () => {
    const { t } = useTranslation();
    const { isAuthenticated } = useOxy();
    const theme = useTheme();
    const { registerHomeRefreshHandler, unregisterHomeRefreshHandler } = useHomeRefresh();
    const [activeTab, setActiveTab] = useState<HomeTab>('for_you');
    const [pinnedFeeds, setPinnedFeeds] = useState<PinnedFeed[]>([]);
    const [myFeeds, setMyFeeds] = useState<any[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);

    // Load pinned feeds function
    const loadFeeds = React.useCallback(async () => {
        if (!isAuthenticated) return;

        try {
            const pinned = (await getData<string[]>(PINNED_KEY)) || [];
            const feeds = await customFeedsService.list({ mine: true });
            setMyFeeds(feeds.items || []);

            const pinnedFeedData = pinned
                .map((id) => {
                    const feedId = id.replace('custom:', '');
                    const feed = feeds.items?.find((f: any) => String(f._id || f.id) === feedId);
                    if (feed) {
                        return {
                            id,
                            title: feed.title,
                            feedId
                        };
                    }
                    return null;
                })
                .filter(Boolean) as PinnedFeed[];

            setPinnedFeeds(pinnedFeedData);
        } catch (error) {
            console.error('Failed to load pinned feeds:', error);
        }
    }, [isAuthenticated]);

    // Load pinned feeds on mount and when screen is focused
    useEffect(() => {
        loadFeeds();
    }, [loadFeeds]);

    useFocusEffect(
        React.useCallback(() => {
            loadFeeds();
        }, [loadFeeds])
    );

    // Reset activeTab if user becomes unauthenticated and current tab is not available
    useEffect(() => {
        if (!isAuthenticated && (activeTab === 'following' || activeTab.startsWith('custom:'))) {
            setActiveTab('for_you');
        }
    }, [isAuthenticated, activeTab]);

    // Register refresh handler from BottomBar
    // This allows BottomBar to trigger refresh when home tab is pressed while already on home
    useEffect(() => {
        const handleRefresh = () => {
            setRefreshKey(prev => prev + 1);
        };
        registerHomeRefreshHandler(handleRefresh);
        return () => {
            unregisterHomeRefreshHandler();
        };
    }, [registerHomeRefreshHandler, unregisterHomeRefreshHandler]);

    const handleTabPress = (tabId: HomeTab) => {
        // If pressing the same tab - scroll to top and refresh
        if (tabId === activeTab) {
            setRefreshKey(prev => prev + 1);
        } else {
            // Different tab - switch (will scroll to top automatically on mount)
            setActiveTab(tabId);
        }
    };

    const renderContent = () => {
        // Check if activeTab is a custom pinned feed (only for authenticated users)
        if (isAuthenticated && activeTab.startsWith('custom:')) {
            const feedId = activeTab.replace('custom:', '');
            const pinnedFeed = pinnedFeeds.find(f => f.feedId === feedId);
            if (pinnedFeed) {
                return (
                    <Feed
                        key={`custom-${feedId}`}
                        type="custom"
                        filters={{
                            customFeedId: feedId
                        }}
                        reloadKey={refreshKey}
                    />
                );
            }
        }

        // For unauthenticated users, show popular posts
        if (!isAuthenticated) {
            switch (activeTab) {
                case 'trending':
                    return (
                        <Feed
                            key="trending"
                            type="explore"
                            reloadKey={refreshKey}
                        />
                    );

                default:
                    // Show popular posts for "For You" tab when not authenticated
                    return (
                        <Feed
                            key="for_you"
                            type="for_you"
                            reloadKey={refreshKey}
                        />
                    );
            }
        }

        // Authenticated users get personalized feeds
        switch (activeTab) {
            case 'following':
                return (
                    <Feed
                        key="following"
                        type="following"
                        reloadKey={refreshKey}
                    />
                );

            case 'trending':
                return (
                    <Feed
                        key="trending"
                        type="explore"
                        reloadKey={refreshKey}
                    />
                );

            default:
                return (
                    <Feed
                        key="for_you"
                        type="for_you"
                        reloadKey={refreshKey}
                    />
                );
        }
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={["top"]}>
            <ThemedView style={{ flex: 1 }}>
                <StatusBar style={theme.isDark ? "light" : "dark"} />

                {/* Header */}
                <Header
                    options={{
                        title: 'Mention',
                        rightComponents: [
                            <TouchableOpacity
                                key="search"
                                style={styles.headerButton}
                                onPress={() => router.push('/search')}
                            >
                                <Ionicons name="search-outline" size={24} color={theme.colors.textSecondary} />
                            </TouchableOpacity>,
                            <TouchableOpacity
                                key="notifications"
                                style={styles.headerButton}
                                onPress={() => router.push('/notifications')}
                            >
                                <Ionicons name="notifications-outline" size={24} color={theme.colors.textSecondary} />
                            </TouchableOpacity>
                        ]
                    }}
                />

                {/* Tab Navigation */}
                <AnimatedTabBar
                    tabs={[
                        { id: 'for_you', label: t('For You') },
                        ...(isAuthenticated ? [{ id: 'following', label: t('Following') }] : []),
                        { id: 'trending', label: t('Trending') },
                        ...(isAuthenticated ? pinnedFeeds.map((feed) => ({ id: feed.id, label: feed.title })) : []),
                    ]}
                    activeTabId={activeTab}
                    onTabPress={handleTabPress}
                    scrollEnabled={isAuthenticated && pinnedFeeds.length > 0}
                />

                {/* Content */}
                {renderContent()}

                {/* Floating Action Button */}
                {isAuthenticated && (
                    <TouchableOpacity
                        style={[styles.fab, { backgroundColor: theme.colors.primary }]}
                        onPress={() => router.push('/compose')}
                    >
                        <Ionicons name="add" size={24} color={theme.colors.card} />
                    </TouchableOpacity>
                )}
            </ThemedView>
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
    fab: {
        position: 'absolute',
        bottom: 24,
        right: 24,
        width: 56,
        height: 56,
        borderRadius: 28,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 8,
    },
});

export default HomeScreen;
