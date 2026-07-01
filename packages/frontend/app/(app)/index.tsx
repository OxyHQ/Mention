import React, { useState, useEffect } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import Feed from '@/components/Feed/Feed';
import { getData } from '@/utils/storage';
import { customFeedsService } from '@/services/customFeedsService';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { useTheme } from '@oxyhq/bloom/theme';
import { useHomeRefresh } from '@/context/HomeRefreshContext';
import { useBottomBarHidden } from '@/context/BottomBarVisibilityContext';
import { useAnimatedStyle, useDerivedValue } from 'react-native-reanimated';
import { BottomBarAwareFab } from '@/components/BottomBarAwareFab';
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
import { PanelStickyHeader, PanelChromeTopInsetProvider, PANEL_HEADER_HEIGHT, PANEL_CHROME_TOP_INSET } from '@/components/shell/PanelChrome';

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
    const [refreshKey, setRefreshKey] = useState(0);
    const headerHeight = PANEL_HEADER_HEIGHT;

    // Shared bottom-bar auto-hide signal (0 = visible, 1 = hidden). The header
    // derives its motion from this one value so it stays in lock-step with the
    // bottom bar — no per-screen duplicate scroll listener.
    const bottomBarHidden = useBottomBarHidden();
    const headerTranslateY = useDerivedValue(() => bottomBarHidden.value * -(headerHeight + insets.top));
    const headerOpacity = useDerivedValue(() => 1 - bottomBarHidden.value);

    // Pinned/custom feeds load once through React Query, keyed on the auth
    // identity, replacing the old useEffect + useFocusEffect pair that fired four
    // requests on mount and an uncached refetch on every screen focus. Cached and
    // deduped; refetches only after the stale window. The inner Promise.all keeps
    // the two list requests parallel.
    const pinnedFeedsQuery = useQuery<PinnedFeed[]>({
        queryKey: ['customFeeds', 'home', user?.id],
        enabled: canUsePrivateApi,
        staleTime: 5 * 60 * 1000,
        queryFn: async () => {
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

                return pinned
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
            } catch (error: unknown) {
                logger.warn('Failed to load pinned feeds', { error });
                return [];
            }
        },
    });

    const pinnedFeeds = pinnedFeedsQuery.data ?? [];

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

    // Tab-bar motion.
    // WEB: the header is `position: sticky` in normal flow and the tab bar sits
    // just below it (`top: 48`); as the header auto-hides (translates up), slide
    // the tab bar up in lock-step so it rises to the panel top instead of leaving
    // a gap.
    // NATIVE: the tab bar is an ABSOLUTE overlay pinned directly below the header
    // (`top: headerHeight`). It rises WITH the header but its travel is clamped at
    // the panel top (`-headerHeight`) so it stays visible once the header is fully
    // gone — reproducing the old `max(0, ...)` spacer behaviour WITHOUT an in-flow
    // spacer, so the feed (which carries a fixed top inset and scrolls behind the
    // chrome) never reflows as the chrome hides.
    const tabBarAnimatedStyle = useAnimatedStyle(() => {
        if (Platform.OS === 'web') {
            return { transform: [{ translateY: headerTranslateY.value }] };
        }
        const translate = Math.max(headerTranslateY.value, -headerHeight);
        return {
            position: 'absolute' as const,
            top: headerHeight,
            left: 0,
            right: 0,
            transform: [{ translateY: translate }],
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

                    {/* Header - animated. <PanelStickyHeader> owns the web sticky
                        position/inset, the opaque `bg-card` surface, the top
                        rounded corners (masking the feed's top-edge bleed), and the
                        z-index. The screen still supplies the reanimated auto-hide
                        translate via `style`. NATIVE: PanelStickyHeader becomes the
                        absolute top overlay. */}
                    <PanelStickyHeader level={0} style={headerAnimatedStyle}>
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
                    </PanelStickyHeader>

                    {/* Tab Navigation. WEB: <PanelStickyHeader level={1}> pins it
                        directly below the level-0 header (at PANEL_TOP_INSET +
                        PANEL_HEADER_HEIGHT) with the same opaque `bg-card` surface
                        and top rounded corners, so the feed is never exposed in the
                        auto-hide gap and the rounded corners keep masking the feed's
                        top-edge bleed when the tab bar rises to the panel top.
                        NATIVE: `tabBarAnimatedStyle` makes it an absolute overlay
                        pinned below the header; both translate from the same
                        `hidden`, in lock-step. zIndex 100 keeps it one below the
                        header (101). */}
                    <PanelStickyHeader level={1} zIndex={100} style={tabBarAnimatedStyle}>
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
                    </PanelStickyHeader>

                    {/* Content. On native the feed scrolls BEHIND the absolute
                        header + tab-bar overlay; PanelChromeTopInsetProvider hands it
                        the fixed top inset (header + tab-bar height) it reserves as
                        constant scrollable padding so hiding the chrome never
                        reflows the list. Web ignores the inset (sticky chrome in
                        normal flow). */}
                    <PanelChromeTopInsetProvider value={PANEL_CHROME_TOP_INSET}>
                        {renderContent()}
                    </PanelChromeTopInsetProvider>

                    {/* Compose FAB that rides the BottomBar's show/hide (web mobile). */}
                    {canUsePrivateApi && (
                        <BottomBarAwareFab
                            onPress={() => router.push('/compose')}
                            icon={<ComposeIcon size={22} className="text-primary-foreground" />}
                            accessibilityLabel={t('compose.newPost', { defaultValue: 'New post' })}
                        />
                    )}
                </ThemedView>
            </SafeAreaView>
        </>
    );
};

export default HomeScreen;
