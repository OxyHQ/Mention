import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import Feed from '../components/Feed/Feed';
import AnimatedTabBar from '../components/common/AnimatedTabBar';
import { useTheme } from '@/hooks/useTheme';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { FloatingActionButton as FAB } from '@/components/ui/Button';
import { Search } from '@/assets/icons/search-icon';
import { WhoToFollowTab } from '@/components/WhoToFollowTab';
import SEO from '@/components/SEO';
import { IconButton } from '@/components/ui/Button';
import { TrendingList } from '@/components/trending/TrendingList';
import { trendingService, TrendingTopic } from '@/services/trendingService';

type ExploreTab = 'all' | 'media' | 'trending' | 'custom' | 'people';

const ExploreScreen: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { scrollY } = useLayoutScroll();
  const [activeTab, setActiveTab] = useState<ExploreTab>('all');
  const headerTranslateY = useSharedValue(0);
  const headerOpacity = useSharedValue(1);
  const fabTranslateY = useSharedValue(0);
  const fabOpacity = useSharedValue(1);
  const headerHeight = 48; // Match header minHeight
  const fabHeight = 80; // FAB height + bottom margin
  const [trendingTopics, setTrendingTopics] = useState<TrendingTopic[]>([]);
  const [trendingRefreshing, setTrendingRefreshing] = useState(false);

  const fetchTrending = useCallback(async () => {
    const topics = await trendingService.getTrending('24h', 20);
    setTrendingTopics(topics);
  }, []);

  const handleTrendingRefresh = useCallback(async () => {
    setTrendingRefreshing(true);
    await fetchTrending();
    setTrendingRefreshing(false);
  }, [fetchTrending]);

  useEffect(() => {
    if (activeTab === 'trending') {
      fetchTrending();
    }
  }, [activeTab, fetchTrending]);

  const renderContent = () => {
    switch (activeTab) {
      case 'media':
        return (
          <Feed type="media" />
        );

      case 'trending':
        return (
          <TrendingList
            topics={trendingTopics}
            onRefresh={handleTrendingRefresh}
            refreshing={trendingRefreshing}
          />
        );

      case 'custom':
        return (
          <Feed type="posts" />
        );

      case 'people':
        return <WhoToFollowTab />;

      default:
        return <Feed type="explore" />;
    }
  };

  // Track scroll direction and animate header and FAB
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

  const tabBarSpacerStyle = useAnimatedStyle(() => {
    // When header is visible (translateY = 0), reserve space for header height
    // When header slides up (translateY < 0), reduce spacer height accordingly
    // This allows tabs to move up smoothly as header disappears
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
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={["top"]}>
        <ThemedView style={{ flex: 1 }}>
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
                    <Search color={theme.colors.text} size={20} />
                  </IconButton>,
                ],
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
                { id: 'all', label: t('All') },
                { id: 'media', label: t('Media') },
                { id: 'trending', label: t('Trending') },
                { id: 'custom', label: t('Custom') },
                { id: 'people', label: t('Who to follow') },
              ]}
              activeTabId={activeTab}
              onTabPress={(id) => setActiveTab(id as ExploreTab)}
              scrollEnabled={true}
            />
          </View>

          {/* Content */}
          {renderContent()}

          {/* Floating Action Button - Search */}
          <FAB
            onPress={() => router.push('/search')}
            customIcon={<Search color={theme.colors.card} size={24} />}
            animatedTranslateY={fabTranslateY}
            animatedOpacity={fabOpacity}
          />
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

export default ExploreScreen;