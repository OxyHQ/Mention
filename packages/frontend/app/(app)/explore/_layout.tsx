import React, { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { router, Slot, usePathname, type Href } from 'expo-router';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { useTheme } from '@oxyhq/bloom/theme';
import { useBottomBarHidden } from '@/context/BottomBarVisibilityContext';
import { useAnimatedStyle, useDerivedValue } from 'react-native-reanimated';
import { BottomBarAwareFab } from '@/components/BottomBarAwareFab';
import { Search } from '@/assets/icons/search-icon';
import SEO from '@/components/SEO';
import { IconButton } from '@/components/ui/Button';
import { PanelStickyHeader, PanelChromeTopInsetProvider, PANEL_HEADER_HEIGHT, PANEL_CHROME_TOP_INSET } from '@/components/shell/PanelChrome';

/**
 * Explore is a routed top-tab cluster: each tab is its own URL under `/explore`
 * (deep-linkable, reload-safe, shareable). This layout owns the shared chrome —
 * the Explore title, the horizontal tab bar (real navigation, not local state),
 * the auto-hiding sticky header insets, and the search FAB — and renders the
 * active child route via `<Slot/>`. The active tab is DERIVED from the current
 * pathname (the single source of truth), so a direct hit on `/explore/trending`
 * lands with that tab selected.
 */

type ExploreTab = 'all' | 'media' | 'trending' | 'people' | 'starter-packs';

/** Tab id → its route. Drives navigation on tap and (in reverse) active detection. */
const TAB_ROUTES: Record<ExploreTab, Href> = {
  all: '/explore',
  media: '/explore/media',
  trending: '/explore/trending',
  people: '/explore/who-to-follow',
  'starter-packs': '/explore/starter-packs',
};

/** Resolve the active tab from the current pathname (route is the source of truth). */
function tabFromPathname(pathname: string | null): ExploreTab {
  if (pathname?.endsWith('/media')) return 'media';
  if (pathname?.endsWith('/trending')) return 'trending';
  if (pathname?.endsWith('/who-to-follow')) return 'people';
  if (pathname?.endsWith('/starter-packs')) return 'starter-packs';
  return 'all';
}

export default function ExploreLayout() {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const activeTab = tabFromPathname(pathname);
  const headerHeight = PANEL_HEADER_HEIGHT;

  // Shared auto-hide signal (0 = visible, 1 = hidden) — the same value the bottom
  // bar and FAB read, so the header stays in lock-step with the bar instead of
  // running a duplicate scroll listener here.
  const hidden = useBottomBarHidden();
  const headerTranslateY = useDerivedValue(() => hidden.value * -(headerHeight + insets.top));
  const headerOpacity = useDerivedValue(() => 1 - hidden.value);

  const handleTabPress = useCallback(
    (id: string) => {
      const route = TAB_ROUTES[id as ExploreTab];
      if (route && id !== activeTab) {
        router.push(route);
      }
    },
    [activeTab],
  );

  const headerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: headerTranslateY.value }],
    opacity: headerOpacity.value,
  }));

  // Tab-bar motion (mirrors `app/(app)/index.tsx`).
  // WEB: sticky in normal flow; slide up in lock-step with the header so it rises
  // to the panel top. NATIVE: an ABSOLUTE overlay pinned directly below the header
  // that rises with it but clamps at the panel top (`-headerHeight`) so it stays
  // visible — no in-flow spacer, so the feed (fixed top inset, scrolls behind the
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

  const tabs = useMemo(
    () => [
      { id: 'all', label: t('All') },
      { id: 'media', label: t('Media') },
      { id: 'trending', label: t('Trending') },
      { id: 'people', label: t('Who to follow') },
      { id: 'starter-packs', label: t('Starter Packs') },
    ],
    [t],
  );

  return (
    <>
      <SEO title={t('seo.explore.title')} description={t('seo.explore.description')} />
      {/* WEB: `web:z-auto` stops these screen wrappers from being their own
          stacking contexts (RN-web otherwise renders every View as
          `position:relative; z-index:0`, which would TRAP the sticky header +
          tab bar below them). Mirrors `app/(app)/index.tsx`. No effect on native. */}
      <SafeAreaView className="flex-1 bg-background web:z-auto" edges={['top']}>
        <ThemedView className="flex-1 web:z-auto relative flex-col">
          <StatusBar style={theme.isDark ? 'light' : 'dark'} />

          {/* Header - animated. <PanelStickyHeader> owns the web sticky
              position/inset, opaque `bg-card` surface, top rounded corners, and
              z-index; the layout supplies the reanimated auto-hide translate.
              NATIVE: PanelStickyHeader becomes the absolute top overlay. */}
          <PanelStickyHeader level={0} style={headerAnimatedStyle}>
            <Header
              options={{
                title: t('Explore'),
                rightComponents: [
                  <IconButton variant="icon" key="search" onPress={() => router.push('/search')}>
                    <Search className="text-foreground" size={20} />
                  </IconButton>,
                ],
              }}
              hideBottomBorder={true}
              disableSticky={true}
            />
          </PanelStickyHeader>

          {/* Tab Navigation. WEB: <PanelStickyHeader level={1}> pins it directly
              below the level-0 header with the same opaque `bg-card` surface + top
              rounded corners; zIndex 100 keeps it one below the header. NATIVE:
              `tabBarAnimatedStyle` makes it an absolute overlay pinned below the
              header. Tapping a tab navigates (router.push) and the active tab is
              derived from the route. Mirrors `app/(app)/index.tsx`. */}
          <PanelStickyHeader level={1} zIndex={100} style={tabBarAnimatedStyle}>
            <AnimatedTabBar
              tabs={tabs}
              activeTabId={activeTab}
              onTabPress={handleTabPress}
              scrollEnabled={true}
              instanceId="explore"
            />
          </PanelStickyHeader>

          {/* Active tab content — the matched child route (its own <Feed/>) flows
              here. On native the feed scrolls BEHIND the absolute header + tab-bar
              overlay; PanelChromeTopInsetProvider hands it the fixed top inset
              (header + tab-bar height) it reserves as constant scrollable padding
              so hiding the chrome never reflows the list. Web ignores the inset
              (sticky chrome in normal flow). */}
          <PanelChromeTopInsetProvider value={PANEL_CHROME_TOP_INSET}>
            <Slot />
          </PanelChromeTopInsetProvider>

          {/* Search FAB that rides the BottomBar's show/hide (web mobile). */}
          <BottomBarAwareFab
            onPress={() => router.push('/search')}
            icon={<Search size={22} className="text-primary-foreground" />}
            accessibilityLabel={t('Search')}
          />
        </ThemedView>
      </SafeAreaView>
    </>
  );
}
