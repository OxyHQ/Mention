import React, { useState, useEffect } from 'react';
import { StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { router, useFocusEffect } from 'expo-router';
import Feed from '@/components/Feed/Feed';
import { getData } from '@/utils/storage';
import { customFeedsService } from '@/services/customFeedsService';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { useTheme } from '@oxyhq/bloom/theme';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { useBottomBarVisibility } from '@/hooks/useBottomBarVisibility';
import Animated, { useAnimatedStyle, useDerivedValue } from 'react-native-reanimated';
import { Fab } from '@oxyhq/bloom/fab';
import { Search } from '@/assets/icons/search-icon';
import { Bell } from '@/assets/icons/bell-icon';
import { ComposeIcon } from '@/assets/icons/compose-icon';
import SEO from '@/components/SEO';
import { IconButton } from '@/components/ui/Button';
import { LogoIcon } from '@/assets/logo';
import { MenuIcon } from '@/assets/icons/menu-icon';
import { useDrawer } from '@/context/DrawerContext';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import { useAuth } from '@oxyhq/services';
import { logger } from '@/lib/logger';

type HomeTab = 'for_you' | 'following' | 'trending' | string;

interface PinnedFeed {
    id: string;
    title: string;
    feedId: string;
}

interface FeedReference {
    _id?: string;
    id?: string;
    title?: string;
}

const PINNED_KEY = 'mention.pinnedFeeds';

const HomeScreen: React.FC = () => {
    const { t } = useTranslation();
    const { isAuthenticated, isAuthResolved, canUsePrivateApi, user } = useAuth();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { open: openDrawer } = useDrawer();
    const isScreenNotMobile = useIsScreenNotMobile();
    const { registerHomeRefreshHandler, unregisterHomeRefreshHandler } = useHomeRefresh();
    const [activeTab, setActiveTab] = useState<HomeTab>('for_you');
    const [pinnedFeeds, setPinnedFeeds] = useState<PinnedFeed[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);
    const headerHeight = 48;

    // Shared bottom-bar auto-hide signal (0 = visible, 1 = hidden). The header
    // derives its motion from this one value so it stays in lock-step with the
    // bottom bar — no per-screen duplicate scroll listener.
    const bottomBarHidden = useBottomBarVisibility();
    const headerTranslateY = useDerivedValue(() => bottomBarHidden.value * -(headerHeight + insets.top));
    const headerOpacity = useDerivedValue(() => 1 - bottomBarHidden.value);

    const loadFeeds = React.useCallback(async () => {
        if (!canUsePrivateApi) return;

        try {
            const pinned = (await getData<string[]>(PINNED_KEY)) || [];

            const [mineFeeds, publicFeeds] = await Promise.all([
                customFeedsService.list({ mine: true }),
                customFeedsService.list({ publicOnly: true })
            ]);

            const myFeedsList = mineFeeds.items || [];
            const publicFeedsList = publicFeeds.items || [];

            const allFeedsMap = new Map<string, FeedReference>();
            [...myFeedsList, ...publicFeedsList].forEach((feed: FeedReference) => {
                const feedId = String(feed._id || feed.id);
                if (!allFeedsMap.has(feedId)) {
                    allFeedsMap.set(feedId, feed);
                }
            });
            const allFeeds = Array.from(allFeedsMap.values());

            const pinnedFeedData = pinned
                .map((id) => {
                    const feedId = id.replace('custom:', '');
                    const feed = allFeeds.find((f) => String(f._id || f.id) === feedId);
                    if (feed) {
                        return {
                            id,
                            title: feed.title || 'Untitled Feed',
                            feedId
                        };
                    }
                    return null;
                })
                .filter(Boolean) as PinnedFeed[];

            setPinnedFeeds(pinnedFeedData);
        } catch (error: unknown) {
            logger.warn('Failed to load pinned feeds', { error });
        }
    }, [canUsePrivateApi]);

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

    const headerAnimatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ translateY: headerTranslateY.value }],
            opacity: headerOpacity.value,
        };
    });

    const tabBarSpacerStyle = useAnimatedStyle(() => {
        // WEB document-scroll model: the header is `position: sticky` (it keeps
        // its own height in normal flow and pins to the viewport top), so no
        // spacer is needed — a spacer would double-count the header height.
        // NATIVE: the header is an absolute overlay (0 flow height), so the
        // spacer reserves the room the header occupies, shrinking as it hides.
        if (Platform.OS === 'web') {
            return { height: 0 };
        }
        const spacerHeight = Math.max(0, headerHeight + headerTranslateY.value);
        return {
            height: spacerHeight,
        };
    });

    // WEB: the sticky tab bar sits at `top: 48` (just under the sticky header).
    // When the header auto-hides (translates up), slide the tab bar up in
    // lock-step so it rises to the viewport top instead of leaving a gap. On
    // native this is unused (the spacer handles the layout).
    const tabBarStickyAnimatedStyle = useAnimatedStyle(() => {
        if (Platform.OS !== 'web') return {};
        return { transform: [{ translateY: headerTranslateY.value }] };
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
        const feedIdentity = canUsePrivateApi && user?.id ? user.id : 'anon';

        if (canUsePrivateApi && activeTab.startsWith('custom:')) {
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

        if (!canUsePrivateApi) {
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
            {/* WEB: `web:z-auto` stops these screen wrappers from being their own
                stacking contexts (RN-web otherwise renders every View as
                `position:relative; z-index:0`, which would TRAP the sticky header
                + tab bar below them). With `z-index:auto` the header (z-101) and
                tab bar (z-100) compete directly in the rounded panel's stacking
                context, so they paint ABOVE the bleed-mask overlay (z-30) and the
                gutter ring never clips them. The feed below them stays at z-0,
                still masked. No effect on native. */}
            <SafeAreaView className="flex-1 bg-background web:z-auto" edges={["top"]}>
                <ThemedView className="flex-1 web:z-auto relative flex-col">
                    <StatusBar style={theme.isDark ? "light" : "dark"} />

                    {/* Header - animated. On web it carries the panel's opaque
                        surface (`bg-card`) + top rounded corners so it sits inside
                        the rounded panel and masks the feed's top-edge bleed. It
                        has NO border of its own — the single continuous rounded
                        border is owned by the frame overlay (in the (app) layout),
                        painted ABOVE this header. */}
                    <Animated.View style={[styles.headerContainer, headerAnimatedStyle]} className="web:bg-card web:rounded-t-[28px] web:sticky web:top-2">
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

                    {/* Tab Navigation - sticky. On web it carries the panel's
                        OPAQUE surface (`bg-card`) so the feed is never visible
                        behind it during the header auto-hide slide — without an
                        opaque bg, the few-ms slide exposed the feed in the gap
                        between the header row and the tabs (the transparent-gap
                        flicker). Header + tabs both translate by the same
                        `headerTranslateY`, so they move in lock-step. It ALSO
                        carries the panel's top rounded corners (`rounded-t-[28px]`):
                        when the header auto-hides and the tab bar rises to the
                        panel's top inset, its rounded top corners mask the feed's
                        top-edge bleed in the rounded-corner triangles (the header
                        does this while visible). A square-cornered tab bar at the
                        top would expose feed content in the panel's rounded corners
                        — the bleed mask (z-30) sits BELOW the tab bar and cannot
                        cover there. While the header is visible the tab bar sits
                        flush below it over the same `bg-card` panel surface, so the
                        rounded top is invisible (same color behind it). */}
                    <Animated.View style={[styles.stickyTabBar, tabBarStickyAnimatedStyle]} className="web:bg-card web:rounded-t-[28px] web:sticky web:top-[56px]">
                        <AnimatedTabBar
                            tabs={[
                                { id: 'for_you', label: t('For You') },
                                ...(canUsePrivateApi ? [{ id: 'following', label: t('Following') }] : []),
                                { id: 'trending', label: t('Trending') },
                                ...(canUsePrivateApi ? pinnedFeeds.map((feed) => ({ id: feed.id, label: feed.title })) : []),
                            ]}
                            activeTabId={activeTab}
                            onTabPress={handleTabPress}
                            scrollEnabled={canUsePrivateApi && pinnedFeeds.length > 0}
                        />
                    </Animated.View>

                    {/* Content */}
                    {renderContent()}

                    {/* Canonical Bloom <Fab>: persistent compose action. The old auto-hide + scroll-to-top icon-swap were dropped when standardizing on the Bloom FAB. */}
                    {canUsePrivateApi && (
                        <Fab
                            onPress={() => router.push('/compose')}
                            offset={16}
                            icon={<ComposeIcon size={22} className="text-primary-foreground" />}
                            accessibilityLabel={t('compose.newPost', { defaultValue: 'New post' })}
                        />
                    )}
                </ThemedView>
            </SafeAreaView>
        </>
    );
};

const styles = StyleSheet.create({
    headerContainer: {
        // WEB sticky + top inset live in NativeWind classes on the Animated.View
        // (`web:sticky web:top-2`): the header pins to the document viewport's top
        // (8px panel gutter inset, NOT top:0 — the bleed-mask's 40px gutter
        // box-shadow covers the top 8px and would clip a header at top:0) and the
        // reanimated translate (driven by window.scrollY) hides it on scroll. The
        // opaque `web:bg-card` class paints the panel surface so the header masks
        // the feed's top-edge bleed. NATIVE: absolute overlay over the inner
        // ScrollView, transparent (the screen owns its background).
        ...Platform.select({
            web: {},
            default: {
                position: 'absolute' as const,
                top: 0,
                backgroundColor: 'transparent',
            },
        }),
        left: 0,
        right: 0,
        zIndex: 101,
    },
    stickyTabBar: {
        // WEB sticky + top inset live in NativeWind classes on the Animated.View
        // (`web:sticky web:top-[56px]`): sit just below the sticky header (8px
        // panel gutter + 48px header height) so both stay pinned while the
        // document scrolls. The opaque `web:bg-card` class owns the surface so the
        // feed is never exposed in the auto-hide gap. NATIVE: relative,
        // transparent so the screen background shows through.
        ...Platform.select({
            web: {},
            default: {
                position: 'relative' as const,
                top: 0,
                backgroundColor: 'transparent',
            },
        }),
        zIndex: 100,
    },
});

export default HomeScreen;
