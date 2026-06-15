import React, { useState, useEffect, useRef } from 'react';
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
import { useBottomBarVisibility } from '@/hooks/useBottomBarVisibility';
import Animated, { useAnimatedStyle, useDerivedValue, useSharedValue, withTiming } from 'react-native-reanimated';
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
const FAB_ICON_SIZE = 22;

// When the bottom bar hides, the FAB stays fully visible and simply drops into the
// space the bar vacated. The drop distance equals the bar-clearance the FAB reserves
// above the bar at rest (FloatingActionButton uses bottomBarHeight = 60), so the FAB
// ends up where the bar was instead of sliding off-screen.
const FAB_BAR_HIDDEN_DROP = 60;

const HomeScreen: React.FC = () => {
    const { t } = useTranslation();
    const { isAuthenticated, isAuthResolved, user } = useAuth();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { open: openDrawer } = useDrawer();
    const isScreenNotMobile = useIsScreenNotMobile();
    const { registerHomeRefreshHandler, unregisterHomeRefreshHandler } = useHomeRefresh();
    const { scrollY, scrollToTop } = useLayoutScroll();
    const [isScrolledDown, setIsScrolledDown] = useState(false);
    const isScrolledDownRef = useRef(false);
    const [activeTab, setActiveTab] = useState<HomeTab>('for_you');
    const [pinnedFeeds, setPinnedFeeds] = useState<PinnedFeed[]>([]);
    const [myFeeds, setMyFeeds] = useState<any[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);
    const headerHeight = 48;
    const fabTransition = useSharedValue(0);

    // Shared bottom-bar auto-hide signal (0 = visible, 1 = hidden). The header and
    // the FAB both derive their motion from this one value so they stay in lock-step
    // with the bottom bar — no per-screen duplicate scroll listener.
    const bottomBarHidden = useBottomBarVisibility();
    const headerTranslateY = useDerivedValue(() => bottomBarHidden.value * -(headerHeight + insets.top));
    const headerOpacity = useDerivedValue(() => 1 - bottomBarHidden.value);
    // The FAB stays fully visible: it drops DOWN into the bar's vacated spot when the
    // bar hides (no opacity fade), and rises back above the bar when it returns.
    const fabTranslateY = useDerivedValue(() => bottomBarHidden.value * FAB_BAR_HIDDEN_DROP);

    useEffect(() => {
        fabTransition.value = withTiming(isScrolledDown ? 1 : 0, { duration: 200 });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fabTransition is a stable shared value ref
    }, [isScrolledDown]);

    const fabComposeStyle = useAnimatedStyle(() => ({
        opacity: 1 - fabTransition.value,
        transform: [{ scale: 1 - fabTransition.value * 0.3 }],
    }));

    const fabArrowStyle = useAnimatedStyle(() => ({
        opacity: fabTransition.value,
        transform: [{ scale: 0.7 + fabTransition.value * 0.3 }],
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
        // Only force-reset auth-only tabs once auth is RESOLVED. During the
        // undetermined cold-boot window `isAuthenticated` is false but not a real
        // logout, so resetting here would fight a session that is about to restore.
        if (isAuthResolved && !isAuthenticated && (activeTab === 'following' || activeTab.startsWith('custom:'))) {
            setActiveTab('for_you');
        }
    }, [isAuthResolved, isAuthenticated, activeTab]);

    useEffect(() => {
        const handleRefresh = () => {
            setRefreshKey(prev => prev + 1);
        };
        registerHomeRefreshHandler(handleRefresh);
        return () => {
            unregisterHomeRefreshHandler();
        };
    }, [registerHomeRefreshHandler, unregisterHomeRefreshHandler]);

    // Track only the "scrolled deep" threshold that flips the FAB between its
    // compose and scroll-to-top affordances (React-rendered + drives onPress). The
    // header / FAB / bottom-bar hide animation is handled by useBottomBarVisibility.
    useEffect(() => {
        const listenerId = scrollY.addListener(({ value }) => {
            const currentScrollY = typeof value === 'number' ? value : 0;
            const nowScrolledDown = currentScrollY > 200;
            if (nowScrolledDown !== isScrolledDownRef.current) {
                isScrolledDownRef.current = nowScrolledDown;
                setIsScrolledDown(nowScrolledDown);
            }
        });

        return () => {
            scrollY.removeListener(listenerId);
        };
    }, [scrollY]);

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
        // Feeds that render in both the anon and authed branches (for_you, trending)
        // must remount when the auth identity flips so their mount-time fetch re-runs
        // against the now-ready token. Without an identity-scoped key, React reconciles
        // the same element across the anon→authed transition and the feed stays stuck
        // on anonymous (or empty) content. This is the belt-and-suspenders guarantee
        // alongside the auth-keyed initial-fetch effect inside useFeedState. The feed
        // itself shows its normal loading spinner while a session restores on cold
        // boot; once auth resolves the key flips anon→userId and the Feed remounts to
        // fetch the authenticated feed.
        const feedIdentity = isAuthenticated && user?.id ? user.id : 'anon';

        if (isAuthenticated && activeTab.startsWith('custom:')) {
            const feedId = activeTab.replace('custom:', '');
            const pinnedFeed = pinnedFeeds.find(f => f.feedId === feedId);
            if (pinnedFeed) {
                return (
                    <Feed
                        key={`custom-${feedId}-${feedIdentity}`}
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
                    return <Feed key={`trending-${feedIdentity}`} type="explore" reloadKey={refreshKey} />;
                default:
                    return <Feed key={`for_you-${feedIdentity}`} type="for_you" reloadKey={refreshKey} />;
            }
        }

        switch (activeTab) {
            case 'following':
                return <Feed key={`following-${feedIdentity}`} type="following" reloadKey={refreshKey} showComposeButton onComposePress={() => router.push('/compose')} />;
            case 'trending':
                return <Feed key={`trending-${feedIdentity}`} type="explore" reloadKey={refreshKey} showComposeButton onComposePress={() => router.push('/compose')} />;
            default:
                return <Feed key={`for_you-${feedIdentity}`} type="for_you" reloadKey={refreshKey} showComposeButton onComposePress={() => router.push('/compose')} />;
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

                    {/* Floating Action Button — compose or scroll-to-top. Stays
                        fully visible at all times: rests above the bottom bar and
                        drops into the bar's vacated spot when the bar auto-hides on
                        scroll (shared visibility signal). No opacity fade. */}
                    {isAuthenticated && (
                        <FAB
                            onPress={isScrolledDown ? scrollToTop : () => router.push('/compose')}
                            animatedTranslateY={fabTranslateY}
                            customIcon={
                                <View style={{ width: FAB_ICON_SIZE, height: FAB_ICON_SIZE }}>
                                    <Animated.View style={[fabComposeStyle, StyleSheet.absoluteFill, styles.fabIconLayer]} pointerEvents="none">
                                        <ComposeIcon size={FAB_ICON_SIZE} className="text-primary-foreground" />
                                    </Animated.View>
                                    <Animated.View style={[fabArrowStyle, StyleSheet.absoluteFill, styles.fabIconLayer]} pointerEvents="none">
                                        <ArrowUp size={FAB_ICON_SIZE} className="text-primary-foreground" />
                                    </Animated.View>
                                </View>
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
    fabIconLayer: {
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export default HomeScreen;
