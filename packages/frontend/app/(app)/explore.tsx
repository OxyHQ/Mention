import React, { useState, useEffect, useCallback } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import Feed from '@/components/Feed/Feed';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { useTheme } from '@/hooks/useTheme';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { FloatingActionButton as FAB } from '@/components/ui/Button';
import { Search } from '@/assets/icons/search-icon';
import { WhoToFollowTab } from '@/components/WhoToFollowTab';
import { StarterPacksTab } from '@/components/StarterPacksTab';
import SEO from '@/components/SEO';
import { IconButton } from '@/components/ui/Button';
import { TrendingList } from '@/components/trending/TrendingList';
import { trendingService, TrendingTopic } from '@/services/trendingService';

type ExploreTab = 'all' | 'media' | 'trending' | 'custom' | 'people' | 'starter-packs';

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
  const headerHeight = 48;
  const fabHeight = 80;
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
        return <Feed type="media" />;
      case 'trending':
        return (
          <TrendingList
            topics={trendingTopics}
            onRefresh={handleTrendingRefresh}
            refreshing={trendingRefreshing}
          />
        );
      case 'custom':
        return <Feed type="posts" />;
      case 'people':
        return <WhoToFollowTab />;
      case 'starter-packs':
        return <StarterPacksTab />;
      default:
        return <Feed type="explore" />;
    }
  };

  useEffect(() => {
    let isScrollingDown = false;
    let lastKnownScrollY = 0;

    const listenerId = scrollY.addListener(({ value }) => {
      const currentScrollY = typeof value === 'number' ? value : 0;
      const scrollDelta = currentScrollY - lastKnownScrollY;

      if (Math.abs(scrollDelta) > 1) {
        isScrollingDown = scrollDelta > 0;
      }

      if (currentScrollY > 50) {
        if (isScrollingDown) {
          headerTranslateY.value = withTiming(-headerHeight - insets.top, { duration: 200 });
          headerOpacity.value = withTiming(0, { duration: 200 });
          fabTranslateY.value = withTiming(fabHeight, { duration: 200 });
          fabOpacity.value = withTiming(0, { duration: 200 });
        } else {
          headerTranslateY.value = withTiming(0, { duration: 200 });
          headerOpacity.value = withTiming(1, { duration: 200 });
          fabTranslateY.value = withTiming(0, { duration: 200 });
          fabOpacity.value = withTiming(1, { duration: 200 });
        }
      } else {
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
                    <Search color={theme.colors.text} size={20} />
                  </IconButton>,
                ],
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
                { id: 'all', label: t('All') },
                { id: 'media', label: t('Media') },
                { id: 'trending', label: t('Trending') },
                { id: 'custom', label: t('Custom') },
                { id: 'people', label: t('Who to follow') },
                { id: 'starter-packs', label: t('Starter Packs') },
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
