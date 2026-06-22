import React, { useState, useCallback, useMemo } from 'react';
import { StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import Feed from '@/components/Feed/Feed';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { useTheme } from '@oxyhq/bloom/theme';
import { useBottomBarVisibility } from '@/hooks/useBottomBarVisibility';
import Animated, { useAnimatedStyle, useDerivedValue } from 'react-native-reanimated';
import { FloatingActionButton as FAB } from '@/components/ui/Button';
import { Search } from '@/assets/icons/search-icon';
import { WhoToFollowTab } from '@/components/WhoToFollowTab';
import { StarterPacksTab } from '@/components/StarterPacksTab';
import SEO from '@/components/SEO';
import { IconButton } from '@/components/ui/Button';
import { TrendsWidget } from '@/components/widgets/TrendsWidget';
import { TrendingList } from '@/components/trending/TrendingList';
import { useTrendsStore } from '@/store/trendsStore';

type ExploreTab = 'all' | 'media' | 'trending' | 'people' | 'starter-packs';

// When the bottom bar hides, the FAB stays fully visible and drops into the space
// the bar vacated. The drop equals the bar-clearance the FAB reserves above the bar
// at rest (FloatingActionButton uses bottomBarHeight = 60), so it lands where the bar
// was instead of sliding off-screen.
const FAB_BAR_HIDDEN_DROP = 60;

const ExploreScreen: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<ExploreTab>('all');
  const headerHeight = 48;

  // Shared auto-hide signal (0 = visible, 1 = hidden) — the same hook the bottom
  // bar uses, so the header and the FAB stay in lock-step with the bar instead of
  // running a duplicate scroll listener here.
  const hidden = useBottomBarVisibility();
  const headerTranslateY = useDerivedValue(() => hidden.value * -(headerHeight + insets.top));
  const headerOpacity = useDerivedValue(() => 1 - hidden.value);
  // The FAB stays fully visible: it drops DOWN into the bar's vacated spot when the
  // bar hides (no opacity fade), and rises back above the bar when it returns. The
  // drop equals the bar-clearance the FAB reserves above the bar (bottomBarHeight = 60).
  const fabTranslateY = useDerivedValue(() => hidden.value * FAB_BAR_HIDDEN_DROP);

  // Trending tab reads from the same store as TrendsWidget — single data source
  const trends = useTrendsStore(state => state.trends);
  const fetchTrends = useTrendsStore(state => state.fetchTrends);
  const [trendingRefreshing, setTrendingRefreshing] = useState(false);

  const handleTabPress = useCallback((id: string) => {
    setActiveTab(id as ExploreTab);
    if (id === 'trending') {
      fetchTrends({ silent: true });
    }
  }, [fetchTrends]);

  const handleTrendingRefresh = useCallback(async () => {
    setTrendingRefreshing(true);
    await fetchTrends();
    setTrendingRefreshing(false);
  }, [fetchTrends]);

  // The trending strip is the scroll-away header of the feed-backed tabs.
  // Memoized so it keeps a stable element identity and does not force the Feed
  // to re-render on every parent render (Feed compares listHeaderComponent by identity).
  const trendsHeader = useMemo(() => <TrendsWidget variant="inline" />, []);

  const renderContent = () => {
    switch (activeTab) {
      case 'media':
        return <Feed type="media" listHeaderComponent={trendsHeader} />;
      case 'trending':
        return (
          <TrendingList
            topics={trends}
            onRefresh={handleTrendingRefresh}
            refreshing={trendingRefreshing}
          />
        );
      case 'people':
        return <WhoToFollowTab />;
      case 'starter-packs':
        return <StarterPacksTab />;
      default:
        return <Feed type="explore" listHeaderComponent={trendsHeader} />;
    }
  };

  const headerAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: headerTranslateY.value }],
      opacity: headerOpacity.value,
    };
  });

  const tabBarSpacerStyle = useAnimatedStyle(() => {
    // WEB document-scroll model: the header is `position: sticky` (keeps its own
    // height in flow + pins to the viewport), so no spacer is needed. NATIVE: the
    // header is an absolute overlay, so the spacer reserves its room.
    if (Platform.OS === 'web') {
      return { height: 0 };
    }
    const spacerHeight = Math.max(0, headerHeight + headerTranslateY.value);
    return {
      height: spacerHeight,
    };
  });

  // WEB: slide the sticky tab bar up in lock-step with the auto-hiding header so
  // it rises to the viewport top instead of leaving a gap. Unused on native.
  const tabBarStickyAnimatedStyle = useAnimatedStyle(() => {
    if (Platform.OS !== 'web') return {};
    return { transform: [{ translateY: headerTranslateY.value }] };
  });

  return (
    <>
      <SEO
        title={t('seo.explore.title')}
        description={t('seo.explore.description')}
      />
      {/* WEB: `web:z-auto` stops these screen wrappers from being their own
          stacking contexts (RN-web otherwise renders every View as
          `position:relative; z-index:0`, which would TRAP the sticky header +
          tab bar below them). With `z-index:auto` the header (z-101) and tab bar
          (z-100) compete directly in the rounded panel's stacking context, so
          they paint ABOVE the bleed-mask overlay (z-30) and the gutter ring
          never clips them. The feed stays at z-0, still masked. Mirrors
          `app/(app)/index.tsx`. No effect on native. */}
      <SafeAreaView className="flex-1 bg-background web:z-auto" edges={["top"]}>
        <ThemedView className="flex-1 web:z-auto">
          <StatusBar style={theme.isDark ? "light" : "dark"} />

          {/* Header - animated. On web it carries the panel's opaque surface
              (`bg-card`) + top rounded corners so it sits inside the rounded panel
              and masks the feed's top-edge bleed. It has NO border of its own —
              the single continuous rounded border is owned by the frame overlay
              (in the (app) layout), painted ABOVE this header. */}
          <Animated.View style={[styles.headerContainer, headerAnimatedStyle]} className="web:bg-card web:rounded-t-[28px] web:sticky web:top-2">
            <Header
              options={{
                title: t('Explore'),
                rightComponents: [
                  <IconButton variant="icon"
                    key="search"
                    onPress={() => router.push('/search')}
                  >
                    <Search className="text-foreground" size={20} />
                  </IconButton>,
                ],
              }}
              hideBottomBorder={true}
              disableSticky={true}
            />
          </Animated.View>

          {/* Spacer for header */}
          <Animated.View style={tabBarSpacerStyle} />

          {/* Tab Navigation - sticky. The trending strip is rendered as the
              feed's ListHeaderComponent so it scrolls away with the content
              while the tab bar stays pinned at the top. On web it carries the
              panel's OPAQUE `bg-card` surface so the feed is never visible behind
              it during the header auto-hide slide (no transparent-gap flicker);
              header + tabs translate by the same value, in lock-step. It ALSO
              carries the panel's top rounded corners (`rounded-t-[28px]`): when the
              header auto-hides and the tab bar rises to the panel's top inset, its
              rounded top corners mask the feed's top-edge bleed in the rounded
              corner triangles (a square-cornered tab bar would expose feed content
              there — the bleed mask sits below it). Mirrors `app/(app)/index.tsx`. */}
          <Animated.View style={[styles.stickyTabBar, tabBarStickyAnimatedStyle]} className="web:bg-card web:rounded-t-[28px] web:sticky web:top-[56px]">
            <AnimatedTabBar
              tabs={[
                { id: 'all', label: t('All') },
                { id: 'media', label: t('Media') },
                { id: 'trending', label: t('Trending') },
                { id: 'people', label: t('Who to follow') },
                { id: 'starter-packs', label: t('Starter Packs') },
              ]}
              activeTabId={activeTab}
              onTabPress={handleTabPress}
              scrollEnabled={true}
            />
          </Animated.View>

          {/* Content */}
          {renderContent()}

          {/* Floating Action Button - Search. Stays fully visible: rests above the
              bottom bar and drops into the bar's vacated spot when the bar auto-hides
              on scroll (shared visibility signal). No opacity fade. */}
          <FAB
            onPress={() => router.push('/search')}
            customIcon={<Search className="text-background" size={24} />}
            animatedTranslateY={fabTranslateY}
          />
        </ThemedView>
      </SafeAreaView>
    </>
  );
};

const styles = StyleSheet.create({
  headerContainer: {
    // WEB sticky + top inset live in NativeWind classes on the Animated.View
    // (`web:sticky web:top-2`): the header pins to the document viewport at the
    // panel's 8px gutter inset (NOT top:0 — the bleed-mask's 40px gutter
    // box-shadow covers the top 8px and would clip it) and the auto-hide translate
    // (driven by window.scrollY) hides it. The opaque `web:bg-card` class paints
    // the panel surface so the header masks the feed's top-edge bleed. NATIVE:
    // transparent absolute overlay over the scrollable content.
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
    // (`web:sticky web:top-[56px]`): sit just below the sticky header (8px panel
    // gutter + 48px header). The opaque `web:bg-card` class owns the surface so
    // the feed is never exposed in the auto-hide gap. NATIVE: relative,
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

export default ExploreScreen;
