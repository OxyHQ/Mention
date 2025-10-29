import React, { useState, useEffect, useMemo } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { shadowStyle } from '@/utils/platformStyles';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import Feed from '../components/Feed/Feed';
import { useOxy } from '@oxyhq/services';
import SignInPrompt from '../components/SignInPrompt';
import { getData } from '@/utils/storage';
import { customFeedsService } from '@/services/customFeedsService';
import AnimatedTabBar from '../components/common/AnimatedTabBar';
import { useTheme } from '@/hooks/useTheme';

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
    const [activeTab, setActiveTab] = useState<HomeTab>('for_you');
    const [pinnedFeeds, setPinnedFeeds] = useState<PinnedFeed[]>([]);
    const [myFeeds, setMyFeeds] = useState<any[]>([]);

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

    const renderContent = () => {
        if (!isAuthenticated) {
            return <SignInPrompt />;
        }

        // Check if activeTab is a custom pinned feed
        if (activeTab.startsWith('custom:')) {
            const feedId = activeTab.replace('custom:', '');
            const pinnedFeed = pinnedFeeds.find(f => f.feedId === feedId);
            if (pinnedFeed) {
                return (
                    <Feed
                        type="mixed"
                        filters={{
                            customFeedId: feedId
                        }}
                        recycleItems={true}
                        maintainVisibleContentPosition={true}
                    />
                );
            }
        }

        switch (activeTab) {
            case 'following':
                return (
                    <Feed
                        type="following"
                        recycleItems={true}
                        maintainVisibleContentPosition={true}
                    />
                );

            case 'trending':
                return (
                    <Feed
                        type="mixed"
                        recycleItems={true}
                        maintainVisibleContentPosition={true}
                    />
                );

            default:
                return (
                    <Feed
                        type="for_you"
                        recycleItems={true}
                        maintainVisibleContentPosition={true}
                    />
                );
        }
    };

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={["top"]}>
            <ThemedView style={{ flex: 1 }}>
                <StatusBar style={theme.isDark ? "light" : "dark"} />

                {/* Header */}
                <View style={[styles.header, { backgroundColor: theme.colors.background, borderBottomColor: theme.colors.border }]}>
                    <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Mention</Text>
                    <View style={styles.headerActions}>
                        <TouchableOpacity
                            style={styles.headerButton}
                            onPress={() => router.push('/search')}
                        >
                            <Ionicons name="search-outline" size={24} color={theme.colors.textSecondary} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.headerButton}
                            onPress={() => router.push('/notifications')}
                        >
                            <Ionicons name="notifications-outline" size={24} color={theme.colors.textSecondary} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Tab Navigation */}
                <AnimatedTabBar
                    tabs={[
                        { id: 'for_you', label: t('For You') },
                        { id: 'following', label: t('Following') },
                        { id: 'trending', label: t('Trending') },
                        ...pinnedFeeds.map((feed) => ({ id: feed.id, label: feed.title })),
                    ]}
                    activeTabId={activeTab}
                    onTabPress={setActiveTab}
                    scrollEnabled={pinnedFeeds.length > 0}
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
        backgroundColor: "#FFFFFF",
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 16,
        paddingHorizontal: 16,
        backgroundColor: "#FFFFFF",
        borderBottomWidth: 0.5,
        borderBottomColor: "#EFF3F4",
        ...shadowStyle({ elevation: 1, web: `0px 1px 4px rgba(0,0,0,0.1)` }),
        // sticky header on web
        ...(Platform.OS === 'web' ? ({ position: 'sticky' as any, top: 0, zIndex: 1000 } as any) : {}),
    },
    headerTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        color: "#0F1419",
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
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
        backgroundColor: "#d169e5",
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 8,
        ...shadowStyle({ elevation: 8, web: `0px 4px 8px rgba(0,0,0,0.2)` }),
        ...(Platform.OS === 'web' ? {
            position: 'fixed' as any,
        } : {}),
    },
});

export default HomeScreen;
