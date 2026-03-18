import React, { useState, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { router, useFocusEffect } from 'expo-router';
import Feed from '@/components/Feed/Feed';
import { useAuth } from '@oxyhq/services';
import { getData } from '@/utils/storage';
import { customFeedsService } from '@/services/customFeedsService';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { useTheme } from '@oxyhq/bloom/theme';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { FloatingActionButton as FAB } from '@/components/ui/Button';
import { Search } from '@/assets/icons/search-icon';
import { Bell } from '@/assets/icons/bell-icon';
import { ComposeIcon } from '@/assets/icons/compose-icon';
import { ArrowUp } from '@/assets/icons/arrow-up-icon';
import SEO from '@/components/SEO';
import { IconButton } from '@/components/ui/Button';
import { LogoIcon } from '@/assets/logo';
import { MenuIcon } from '@/assets/icons/menu-icon';
import { useDrawer } from '@/context/DrawerContext';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

type HomeTab = 'for_you' | 'following' | 'trending' | string;

interface PinnedFeed {
    id: string;
    title: string;
    feedId: string;
}

const PINNED_KEY = 'mention.pinnedFeeds';

const HomeScreen: React.FC = () => {
    const { t } = useTranslation();
    const { isAuthenticated } = useAuth();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { open: openDrawer } = useDrawer();
    const isScreenNotMobile = useIsScreenNotMobile();
    const { registerHomeRefreshHandler, unregisterHomeRefreshHandler } = useHomeRefresh();
    const { scrollY, scrollToTop } = useLayoutScroll();
    const [isScrolledDown, setIsScrolledDown] = useState(false);
    const [activeTab, setActiveTab] = useState<HomeTab>('for_you');
    const [pinnedFeeds, setPinnedFeeds] = useState<PinnedFeed[]>([]);
    const [myFeeds, setMyFeeds] = useState<any[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);
    const headerTranslateY = useSharedValue(0);
    const headerOpacity = useSharedValue(1);
    const headerHeight = 48;
    const fabIconRotation = useSharedValue(0);

    useEffect(() => {
        fabIconRotation.value = withSpring(isScrolledDown ? 1 : 0, {
            damping: 15,
            stiffness: 150,
        });
    }, [isScrolledDown, fabIconRotation]);

    const fabIconAnimatedStyle = useAnimatedStyle(() => ({
        transform: [
            { rotate: `${fabIconRotation.value * 180}deg` },
            { scale: 1 - Math.abs(fabIconRotation.value - 0.5) * 0.4 },
        ],
    }));

    const loadFeeds = React.useCallback(async () => {
        if (!isAuthenticated) return;

        try {
            const pinned = (await getData<string[]>(PINNED_KEY)) || [];

            const [mineFeeds, publicFeeds] = await Promise.all([
                customFeedsService.list({ mine: true }),
                customFeedsService.list({ publicOnly: true })
            ]);

            const myFeedsList = mineFeeds.items || [];
            const publicFeedsList = publicFeeds.items || [];

            const allFeedsMap = new Map<string, any>();
            [...myFeedsList, ...publicFeedsList].forEach((feed: any) => {
                const feedId = String(feed._id || feed.id);
                if (!allFeedsMap.has(feedId)) {
                    allFeedsMap.set(feedId, feed);
                }
            });
            const allFeeds = Array.from(allFeedsMap.values());

            setMyFeeds(myFeedsList);

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
                    return null;
                })
                .filter(Boolean) as PinnedFeed[];

            setPinnedFeeds(pinnedFeedData);
        } catch (error: any) {
            // Silently ignore errors
        }
    }, [isAuthenticated]);

    useEffect(() => {
        loadFeeds();
    }, [loadFeeds]);

    useFocusEffect(
        React.useCallback(() => {
            loadFeeds();
        }, [loadFeeds])
    );

    useEffect(() => {
        if (!isAuthenticated && (activeTab === 'following' || activeTab.startsWith('custom:'))) {
            setActiveTab('for_you');
        }
    }, [isAuthenticated, activeTab]);

    useEffect(() => {
        const handleRefresh = () => {
            setRefreshKey(prev => prev + 1);
        };
        registerHomeRefreshHandler(handleRefresh);
        return () => {
            unregisterHomeRefreshHandler();
        };
    }, [registerHomeRefreshHandler, unregisterHomeRefreshHandler]);

    useEffect(() => {
        let isScrollingDown = false;
        let lastKnownScrollY = 0;

        const listenerId = scrollY.addListener(({ value }) => {
            const currentScrollY = typeof value === 'number' ? value : 0;
            const scrollDelta = currentScrollY - lastKnownScrollY;

            if (Math.abs(scrollDelta) > 1) {
                isScrollingDown = scrollDelta > 0;
            }

            setIsScrolledDown(currentScrollY > 200);

            if (currentScrollY > 50) {
                if (isScrollingDown) {
                    headerTranslateY.value = withTiming(-headerHeight - insets.top, { duration: 200 });
                    headerOpacity.value = withTiming(0, { duration: 200 });
                } else {
                    headerTranslateY.value = withTiming(0, { duration: 200 });
                    headerOpacity.value = withTiming(1, { duration: 200 });
                }
            } else {
                headerTranslateY.value = withTiming(0, { duration: 200 });
                headerOpacity.value = withTiming(1, { duration: 200 });
            }

            lastKnownScrollY = currentScrollY;
        });

        return () => {
            scrollY.removeListener(listenerId);
        };
    }, [scrollY, headerTranslateY, headerOpacity, headerHeight, insets.top]);

    const headerAnimatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ translateY: headerTranslateY.value }],
            opacity: headerOpacity.value,
        };
    });

    const tabBarSpacerStyle = useAnimatedStyle(() => {
        const spacerHeight = Math.max(0, headerHeight + headerTranslateY.value);
        return {
            height: spacerHeight,
        };
    });

    const handleTabPress = (tabId: HomeTab) => {
        if (tabId === activeTab) {
            setRefreshKey(prev => prev + 1);
        } else {
            setActiveTab(tabId);
        }
    };

    const renderContent = () => {
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
                        showComposeButton
                        onComposePress={() => router.push('/compose')}
                    />
                );
            }
        }

        if (!isAuthenticated) {
            switch (activeTab) {
                case 'trending':
                    return <Feed key="trending" type="explore" reloadKey={refreshKey} />;
                default:
                    return <Feed key="for_you" type="for_you" reloadKey={refreshKey} />;
            }
        }

        switch (activeTab) {
            case 'following':
                return <Feed key="following" type="following" reloadKey={refreshKey} showComposeButton onComposePress={() => router.push('/compose')} />;
            case 'trending':
                return <Feed key="trending" type="explore" reloadKey={refreshKey} showComposeButton onComposePress={() => router.push('/compose')} />;
            default:
                return <Feed key="for_you" type="for_you" reloadKey={refreshKey} showComposeButton onComposePress={() => router.push('/compose')} />;
        }
    };

    return (
        <>
            <SEO
                title={t('seo.home.title')}
                description={t('seo.home.description')}
            />
            <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
                <ThemedView className="flex-1">
                    <StatusBar style={theme.isDark ? "light" : "dark"} />

                    {/* Header - animated */}
                    <Animated.View style={[styles.headerContainer, headerAnimatedStyle]}>
                        <Header
                            options={{
                                titlePosition: 'center',
                                subtitle: <LogoIcon size={28} className="text-foreground" />,
                                leftComponents: !isScreenNotMobile ? [
                                    <IconButton variant="icon"
                                        key="menu"
                                        onPress={openDrawer}
                                    >
                                        <MenuIcon size={22} className="text-foreground" />
                                    </IconButton>
                                ] : [],
                                rightComponents: [
                                    <IconButton variant="icon"
                                        key="search"
                                        onPress={() => router.push('/search')}
                                    >
                                        <Search className="text-foreground" size={20} />
                                    </IconButton>,
                                    <IconButton variant="icon"
                                        key="notifications"
                                        onPress={() => router.push('/notifications')}
                                    >
                                        <Bell size={20} className="text-foreground" />
                                    </IconButton>
                                ]
                            }}
                            hideBottomBorder={true}
                            disableSticky={true}
                        />
                    </Animated.View>

                    {/* Spacer for header */}
                    <Animated.View style={tabBarSpacerStyle} />

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

                    {/* Floating Action Button — compose or scroll-to-top */}
                    {isAuthenticated && (
                        <FAB
                            onPress={isScrolledDown ? scrollToTop : () => router.push('/compose')}
                            customIcon={
                                <Animated.View style={fabIconAnimatedStyle}>
                                    {isScrolledDown
                                        ? <ArrowUp size={22} className="text-primary-foreground" />
                                        : <ComposeIcon size={22} className="text-primary-foreground" />
                                    }
                                </Animated.View>
                            }
                        />
                    )}
                </ThemedView>
            </SafeAreaView>
        </>
    );
};

const styles = StyleSheet.create({
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
});

export default HomeScreen;
