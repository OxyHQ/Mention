import React, { useState, useEffect } from 'react';
import { StyleSheet, View, TouchableOpacity, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { useTranslation } from 'react-i18next';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Feed from '../components/Feed/Feed';
import AnimatedTabBar from '../components/common/AnimatedTabBar';
import { useTheme } from '@/hooks/useTheme';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { FloatingActionButton } from '@/components/FloatingActionButton';
import { Search } from '@/assets/icons/search-icon';

type ExploreTab = 'all' | 'media' | 'trending' | 'custom';

const ExploreScreen: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { scrollY } = useLayoutScroll();
  const [activeTab, setActiveTab] = useState<ExploreTab>('all');
  const headerTranslateY = useSharedValue(0);
  const fabTranslateY = useSharedValue(0);
  const headerHeight = 48; // Match header minHeight
  const fabHeight = 80; // FAB height + bottom margin

  const renderContent = () => {
    switch (activeTab) {
      case 'media':
        return (
          <Feed type="media" recycleItems={true} maintainVisibleContentPosition={true} />
        );

      case 'trending':
        return (
          <Feed type="explore" recycleItems={true} maintainVisibleContentPosition={true} />
        );

      case 'custom':
        return (
          <Feed type="posts" recycleItems={true} maintainVisibleContentPosition={true} />
        );

      default:
        return <Feed type="explore" recycleItems={true} maintainVisibleContentPosition={true} />;
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
          // Scrolling down - hide header and FAB
          headerTranslateY.value = withTiming(-headerHeight, { duration: 200 });
          fabTranslateY.value = withTiming(fabHeight, { duration: 200 });
        } else {
          // Scrolling up - show header and FAB
          headerTranslateY.value = withTiming(0, { duration: 200 });
          fabTranslateY.value = withTiming(0, { duration: 200 });
        }
      } else {
        // Near top - always show header and FAB
        headerTranslateY.value = withTiming(0, { duration: 200 });
        fabTranslateY.value = withTiming(0, { duration: 200 });
      }
      
      lastKnownScrollY = currentScrollY;
    });
    
    return () => {
      scrollY.removeListener(listenerId);
    };
  }, [scrollY, headerTranslateY, fabTranslateY, headerHeight, fabHeight]);

  const headerAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateY: headerTranslateY.value }],
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
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={["top"]}>
      <ThemedView style={{ flex: 1 }}>
        <StatusBar style={theme.isDark ? "light" : "dark"} />

        {/* Header - animated */}
        <Animated.View style={[styles.headerContainer, headerAnimatedStyle]}>
          <Header
            options={{
              title: t('Explore'),
              rightComponents: [
                <TouchableOpacity
                  key="search"
                  onPress={() => router.push('/search')}
                  style={{ padding: 8 }}
                >
                  <Search color={theme.colors.textSecondary} size={24} />
                </TouchableOpacity>,
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
            ]}
            activeTabId={activeTab}
            onTabPress={(id) => setActiveTab(id as ExploreTab)}
            scrollEnabled={true}
          />
        </View>

        {/* Content */}
        {renderContent()}

        {/* Floating Action Button - Search */}
        <FloatingActionButton
          onPress={() => router.push('/search')}
          customIcon={<Search color={theme.colors.card} size={24} />}
          animatedTranslateY={fabTranslateY}
        />
      </ThemedView>
    </SafeAreaView>
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