import React, { useState, useEffect, useMemo } from 'react';
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
import { customFeedsService } from '@/services/customFeedsService';
import { useFeedPreferences } from '@/hooks/useFeedPreferences';
import { PRESET_FEEDS, parseFeedDescriptor, type FeedType } from '@mention/shared-types';
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

type HomeTab = string;

/**
 * A resolved home tab derived from a pinned {@link SavedFeed}. `descriptor` tabs
 * render an inline `<Feed>`; `custom` tabs render the engine timeline.
 */
type HomeTabModel =
    | { key: string; label: string; kind: 'descriptor'; type: FeedType }
    | { key: string; label: string; kind: 'custom'; feedId: string };

const HomeScreen: React.FC = () => {
    const { t } = useTranslation();
    const { isAuthResolved, canUsePrivateApi, user } = useAuth();
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

    // The home tabs ARE the viewer's server-persisted pinned feeds (server order),
    // so pinning in the feeds screen updates the tab bar cross-device. Anonymous
    // viewers get the read-only default (For You).
    const { pinnedFeeds } = useFeedPreferences();

    const presetById = useMemo(() => new Map(PRESET_FEEDS.map((p) => [p.id, p])), []);

    // Whether any pinned feed is a custom feed — gates the (title-only) custom-feed
    // fetch so users with no custom pins never trigger it.
    const hasPinnedCustom = useMemo(
        () => pinnedFeeds.some((sf) => parseFeedDescriptor(sf.descriptor).source === 'custom'),
        [pinnedFeeds],
    );

    // Resolve custom-feed ids → titles for the tab labels (pinned custom feeds
    // carry only a descriptor). Keyed on the auth identity; cached + deduped.
    const customTitlesQuery = useQuery<Map<string, string>>({
        queryKey: ['customFeeds', 'titles', user?.id],
        enabled: canUsePrivateApi && hasPinnedCustom,
        staleTime: 5 * 60 * 1000,
        queryFn: async () => {
            const map = new Map<string, string>();
            try {
                const [mine, pub] = await Promise.all([
                    customFeedsService.list({ mine: true }),
                    customFeedsService.list({ publicOnly: true }),
                ]);
                [...(mine.items || []), ...(pub.items || [])].forEach((feed) => {
                    const feedId = String(feed._id || feed.id);
                    if (!map.has(feedId)) map.set(feedId, feed.title || t('feeds.untitled', { defaultValue: 'Feed' }));
                });
            } catch (error) {
                logger.warn('Failed to load custom feed titles', { error });
            }
            return map;
        },
    });

    const customTitles = customTitlesQuery.data;

    const homeTabs = useMemo<HomeTabModel[]>(() => {
        return pinnedFeeds
            .filter((sf) => {
                // Belt-and-suspenders: hide viewer-relative presets + custom feeds
                // for anonymous viewers (the hook's anon default already excludes them).
                if (canUsePrivateApi) return true;
                const preset = presetById.get(sf.key);
                return preset ? !preset.requiresAuth : false;
            })
            .map((sf): HomeTabModel => {
                const { source, params } = parseFeedDescriptor(sf.descriptor);
                if (source === 'custom') {
                    const feedId = params[0] ?? '';
                    return {
                        key: sf.key,
                        kind: 'custom',
                        feedId,
                        label: customTitles?.get(feedId) ?? t('feeds.untitled', { defaultValue: 'Feed' }),
                    };
                }
                const preset = presetById.get(sf.key);
                return {
                    key: sf.key,
                    kind: 'descriptor',
                    type: source as FeedType,
                    label: preset ? t(preset.labelKey) : sf.descriptor,
                };
            });
    }, [pinnedFeeds, canUsePrivateApi, presetById, customTitles, t]);

    useEffect(() => {
        // Keep the active tab valid as the pinned set changes (e.g. logout removes
        // Following / custom tabs → fall back to the first tab, For You). Only act
        // once auth is RESOLVED so the cold-boot window doesn't fight a session
        // that is about to restore.
        if (!isAuthResolved) return;
        if (homeTabs.length > 0 && !homeTabs.some((tab) => tab.key === activeTab)) {
            setActiveTab(homeTabs[0].key);
        }
    }, [isAuthResolved, homeTabs, activeTab]);

    useEffect(() => {
        const handleRefresh = () => {
            setRefreshKey(prev => prev + 1);
        };
        registerHomeRefreshHandler(handleRefresh);
        return () => {
            unregisterHomeRefreshHandler();
        };
    }, [registerHomeRefreshHandler, unregisterHomeRefreshHandler]);

    // Translate-only: the header is an opaque `bg-background` surface that slides
    // up behind the status bar. Fading its opacity would make the scrolled feed
    // visible through it (the header/tab-bar chrome must read as one continuous
    // opaque surface while rising), so there is NO opacity term here.
    const headerAnimatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ translateY: headerTranslateY.value }],
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
        // Feeds that render in both the anon and authed branches (for_you, …) must
        // remount when the auth identity flips so their mount-time fetch re-runs
        // against the now-ready token. Without an identity-scoped key, React
        // reconciles the same element across the anon→authed transition and the feed
        // stays stuck on anonymous (or empty) content. This is the belt-and-suspenders
        // guarantee alongside the auth-keyed initial-fetch effect inside useFeedState.
        const feedIdentity = canUsePrivateApi && user?.id ? user.id : 'anon';

        // Resolve the active tab; fall back to the first tab (For You) if the active
        // key is momentarily stale (the reset effect converges it next render).
        const tab = homeTabs.find((x) => x.key === activeTab) ?? homeTabs[0];
        const composeProps = canUsePrivateApi
            ? { showComposeButton: true, onComposePress: () => router.push('/compose') }
            : {};

        if (!tab) {
            return <Feed key={`for_you-${feedIdentity}`} type="for_you" reloadKey={refreshKey} {...composeProps} />;
        }

        if (tab.kind === 'custom') {
            return (
                <Feed
                    key={`custom-${tab.feedId}-${feedIdentity}`}
                    type="custom"
                    filters={{ customFeedId: tab.feedId }}
                    reloadKey={refreshKey}
                    {...composeProps}
                />
            );
        }

        return (
            <Feed
                key={`${tab.type}-${feedIdentity}`}
                type={tab.type}
                reloadKey={refreshKey}
                {...composeProps}
            />
        );
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
                            tabs={homeTabs.map((tab) => ({ id: tab.key, label: tab.label }))}
                            activeTabId={activeTab}
                            onTabPress={handleTabPress}
                            scrollEnabled={homeTabs.length > 3}
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
