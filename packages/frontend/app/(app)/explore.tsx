import React, { useState, useCallback, useMemo } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
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
    const spacerHeight = Math.max(0, headerHeight + headerTranslateY.value);
    return {
      height: spacerHeight,
    };
  });

  return (
    <>
      <SEO
        title={t('seo.explore.title')}
        description={t('seo.explore.description')}
      />
      <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
        <ThemedView className="flex-1">
          <StatusBar style={theme.isDark ? "light" : "dark"} />

          {/* Header - animated */}
          <Animated.View style={[styles.headerContainer, headerAnimatedStyle]}>
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
              while the tab bar stays pinned at the top. */}
          <View style={styles.stickyTabBar}>
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
          </View>

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

export default ExploreScreen;
