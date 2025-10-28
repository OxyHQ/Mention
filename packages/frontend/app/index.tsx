import React, { useState, useEffect, useMemo } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Platform, ScrollView } from 'react-native';
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
        <SafeAreaView style={styles.container} edges={["top"]}>
            <ThemedView style={{ flex: 1 }}>
                <StatusBar style="dark" />

                {/* Header */}
                <View style={styles.header}>
                    <Text style={styles.headerTitle}>Mention</Text>
                    <View style={styles.headerActions}>
                        <TouchableOpacity
                            style={styles.headerButton}
                            onPress={() => router.push('/search')}
                        >
                            <Ionicons name="search-outline" size={24} color={colors.COLOR_BLACK_LIGHT_3} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.headerButton}
                            onPress={() => router.push('/notifications')}
                        >
                            <Ionicons name="notifications-outline" size={24} color={colors.COLOR_BLACK_LIGHT_3} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Tab Navigation */}
                <View style={styles.tabsContainer}>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={styles.tabsScrollView}
                    >
                        <TouchableOpacity
                            style={[styles.tab, activeTab === 'for_you' && styles.activeTab]}
                            onPress={() => setActiveTab('for_you')}
                        >
                            <Text style={[styles.tabText, activeTab === 'for_you' && styles.activeTabText]}>
                                {t('For You')}
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.tab, activeTab === 'following' && styles.activeTab]}
                            onPress={() => setActiveTab('following')}
                        >
                            <Text style={[styles.tabText, activeTab === 'following' && styles.activeTabText]}>
                                {t('Following')}
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.tab, activeTab === 'trending' && styles.activeTab]}
                            onPress={() => setActiveTab('trending')}
                        >
                            <Text style={[styles.tabText, activeTab === 'trending' && styles.activeTabText]}>
                                {t('Trending')}
                            </Text>
                        </TouchableOpacity>

                        {/* Pinned Feeds Tabs */}
                        {pinnedFeeds.map((feed) => (
                            <TouchableOpacity
                                key={feed.id}
                                style={[styles.tab, activeTab === feed.id && styles.activeTab]}
                                onPress={() => setActiveTab(feed.id)}
                            >
                                <Text style={[styles.tabText, activeTab === feed.id && styles.activeTabText]} numberOfLines={1}>
                                    {feed.title}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </ScrollView>
                </View>

                {/* Content */}
                {renderContent()}

                {/* Floating Action Button */}
                {isAuthenticated && (
                    <TouchableOpacity
                        style={styles.fab}
                        onPress={() => router.push('/compose')}
                    >
                        <Ionicons name="add" size={24} color={colors.COLOR_BLACK_LIGHT_9} />
                    </TouchableOpacity>
                )}
            </ThemedView>
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
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 16,
        paddingHorizontal: 16,
        backgroundColor: 'white',
        borderBottomWidth: 0.5,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        ...shadowStyle({ elevation: 1, web: `0px 1px 4px ${colors.shadow}` }),
        // sticky header on web
        ...(Platform.OS === 'web' ? ({ position: 'sticky' as any, top: 0, zIndex: 1000 } as any) : {}),
    },
    headerTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK_LIGHT_1,
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    headerButton: {
        padding: 8,
        marginLeft: 8,
    },
    tabsContainer: {
        backgroundColor: 'white',
        borderBottomWidth: 0.5,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    tabsScrollView: {
        flexGrow: 0,
    },
    tab: {
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 20,
    },
    activeTab: {
        borderBottomWidth: 3,
        borderBottomColor: colors.primaryColor,
    },
    tabText: {
        fontSize: 13,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_3,
        textAlign: 'center',
    },
    activeTabText: {
        color: colors.primaryColor,
        fontWeight: 'bold',
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
        ...shadowStyle({ elevation: 8, web: `0px 4px 8px ${colors.shadow}` }),
        ...(Platform.OS === 'web' ? {
            position: 'fixed' as any,
        } : {}),
    },
});

export default HomeScreen;
