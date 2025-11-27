import React, { useState, useEffect, useMemo } from 'react';
import { StyleSheet, View, TouchableOpacity, Platform } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import Animated, { useAnimatedStyle, useSharedValue, withTiming, interpolate } from 'react-native-reanimated';
import { FloatingActionButton as FAB } from '@/components/ui/Button';
import { Search } from '@/assets/icons/search-icon';
import SEO from '@/components/SEO';
import { IconButton } from '@/components/ui/Button';

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
    const insets = useSafeAreaInsets();
    const { registerHomeRefreshHandler, unregisterHomeRefreshHandler } = useHomeRefresh();
    const { scrollY } = useLayoutScroll();
    const [activeTab, setActiveTab] = useState<HomeTab>('for_you');
    const [pinnedFeeds, setPinnedFeeds] = useState<PinnedFeed[]>([]);
    const [myFeeds, setMyFeeds] = useState<any[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);
    const headerTranslateY = useSharedValue(0);
    const headerOpacity = useSharedValue(1);
    const fabTranslateY = useSharedValue(0);
    const fabOpacity = useSharedValue(1);
    const headerHeight = 48; // Match header minHeight
    const fabHeight = 80; // FAB height + bottom margin

    // Load pinned feeds function
    const loadFeeds = React.useCallback(async () => {
        if (!isAuthenticated) return;

        try {
            const pinned = (await getData<string[]>(PINNED_KEY)) || [];
            
            // Fetch both user's feeds and public feeds to find all pinned feeds
            const [mineFeeds, publicFeeds] = await Promise.all([
                customFeedsService.list({ mine: true }),
                customFeedsService.list({ publicOnly: true })
            ]);
            
            const myFeedsList = mineFeeds.items || [];
            const publicFeedsList = publicFeeds.items || [];
            
            // Combine feeds, deduplicating by id
            const allFeedsMap = new Map<string, any>();
            [...myFeedsList, ...publicFeedsList].forEach((feed: any) => {
                const feedId = String(feed._id || feed.id);
                if (!allFeedsMap.has(feedId)) {
                    allFeedsMap.set(feedId, feed);
                }
            });
            const allFeeds = Array.from(allFeedsMap.values());
            
            setMyFeeds(myFeedsList);

            // Find pinned feeds from all available feeds (mine + public)
            const pinnedFeedData = pinned
                .map((id) => {
                    const feedId = id.replace('custom:', '');
                    const feed = allFeeds.find((f: any) => String(f._id || f.id) === feedId);
                    if (feed) {
                        return {
                            id,
                            title: feed.title,
                            feedId
                        };
                    }
                    console.warn(`[HomeScreen] Pinned feed not found: ${feedId}`, {
                        pinnedIds: pinned,
                        availableFeedIds: allFeeds.map((f: any) => String(f._id || f.id))
                    });
                    return null;
                })
                .filter(Boolean) as PinnedFeed[];

            console.log('[HomeScreen] Loaded pinned feeds:', {
                pinnedCount: pinnedFeedData.length,
                pinnedFeeds: pinnedFeedData.map(f => ({ id: f.id, title: f.title }))
            });

            setPinnedFeeds(pinnedFeedData);
        } catch (error: any) {
            if (error?.response?.status === 401 || error?.status === 401) return;
            console.error('Failed to load pinned feeds:', error?.message || error);
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

    // Track scroll direction and animate header
    useEffect(() => {
        let isScrollingDown = false;
        let lastKnownScrollY = 0;
        
        const listenerId = scrollY.addListener(({ value }) => {
            const currentScrollY = typeof value === 'number' ? value : 0;
            const scrollDelta = currentScrollY - lastKnownScrollY;
            
            // Determine scroll direction (only update if movement is significant)
            if (Math.abs(scrollDelta) > 1) {
                isScrollingDown = scrollDelta > 0;
            }
            
            if (currentScrollY > 50) { // Only hide after scrolling past threshold
                if (isScrollingDown) {
                    // Scrolling down - hide header and FAB with opacity
                    headerTranslateY.value = withTiming(-headerHeight - insets.top, { duration: 200 });
                    headerOpacity.value = withTiming(0, { duration: 200 });
                    fabTranslateY.value = withTiming(fabHeight, { duration: 200 });
                    fabOpacity.value = withTiming(0, { duration: 200 });
                } else {
                    // Scrolling up - show header and FAB
                    headerTranslateY.value = withTiming(0, { duration: 200 });
                    headerOpacity.value = withTiming(1, { duration: 200 });
                    fabTranslateY.value = withTiming(0, { duration: 200 });
                    fabOpacity.value = withTiming(1, { duration: 200 });
                }
            } else {
                // Near top - always show header and FAB
                headerTranslateY.value = withTiming(0, { duration: 200 });
                headerOpacity.value = withTiming(1, { duration: 200 });
                fabTranslateY.value = withTiming(0, { duration: 200 });
                fabOpacity.value = withTiming(1, { duration: 200 });
            }
            
            lastKnownScrollY = currentScrollY;
        });
        
        return () => {
            scrollY.removeListener(listenerId);
        };
        }, [scrollY, headerTranslateY, headerOpacity, fabTranslateY, fabOpacity, headerHeight, fabHeight, insets.top]);

    const headerAnimatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ translateY: headerTranslateY.value }],
            opacity: headerOpacity.value,
        };
    });

    const fabAnimatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ translateY: fabTranslateY.value }],
        };
    });

    const tabBarSpacerStyle = useAnimatedStyle(() => {
        // When header is visible (translateY = 0), reserve space for header height
        // When header slides up (translateY < 0), reduce spacer height accordingly
        // This allows tabs to move up smoothly as header disappears
        const spacerHeight = Math.max(0, headerHeight + headerTranslateY.value);
        return {
            height: spacerHeight,
        };
    });

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
        <>
            <SEO
                title={t('seo.home.title')}
                description={t('seo.home.description')}
            />
            <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={["top"]}>
                <ThemedView style={{ flex: 1 }}>
                    <StatusBar style={theme.isDark ? "light" : "dark"} />

                {/* Header - animated */}
                <Animated.View style={[styles.headerContainer, headerAnimatedStyle]}>
                    <Header
                        options={{
                            title: 'Mention',
                            rightComponents: [
                                <IconButton variant="icon"
                                    key="search"
                                    onPress={() => router.push('/search')}
                                >
                                    <Search color={theme.colors.text} size={20} />
                                </IconButton>,
                                <IconButton variant="icon"
                                    key="notifications"
                                    onPress={() => router.push('/notifications')}
                                >
                                    <Ionicons name="notifications-outline" size={20} color={theme.colors.text} />
                                </IconButton>
                            ]
                        }}
                        hideBottomBorder={true}
                        disableSticky={true}
                    />
                </Animated.View>

                {/* Spacer for header - maintains layout space */}
                <Animated.View style={[styles.tabBarSpacer, tabBarSpacerStyle]} />
                
                {/* Tab Navigation - sticky */}
                <View style={styles.stickyTabBar}>
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
                </View>

                {/* Content */}
                {renderContent()}

                {/* Floating Action Button */}
                {isAuthenticated && (
                    <FAB
                        onPress={() => router.push('/compose')}
                        animatedTranslateY={fabTranslateY}
                        animatedOpacity={fabOpacity}
                    />
                )}
            </ThemedView>
        </SafeAreaView>
        </>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    headerContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 101,
        backgroundColor: 'transparent',
    },
    stickyTabBar: {
        ...Platform.select({
            web: {
                position: 'sticky',
            },
            default: {
                position: 'relative',
            },
        }),
        top: 0,
        zIndex: 100,
        backgroundColor: 'transparent',
    },
    tabBarSpacer: {
        // Spacer maintains space for header when it's visible
        // This ensures tabs don't jump when header slides up
    },
});

export default HomeScreen;
