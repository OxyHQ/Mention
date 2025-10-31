import React, { useState } from 'react';
import { StyleSheet, View, TouchableOpacity } from 'react-native';
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

type ExploreTab = 'all' | 'media' | 'trending' | 'custom';

const ExploreScreen: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<ExploreTab>('all');

  const renderContent = () => {
    switch (activeTab) {
      case 'media':
        return (
          <Feed type="media" recycleItems={true} maintainVisibleContentPosition={true} />
        );

      case 'trending':
        return (
          <Feed type="mixed" recycleItems={true} maintainVisibleContentPosition={true} />
        );

      case 'custom':
        return (
          <Feed type="posts" recycleItems={true} maintainVisibleContentPosition={true} />
        );

      default:
        return <Feed type="mixed" recycleItems={true} maintainVisibleContentPosition={true} />;
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={["top"]}>
      <ThemedView style={{ flex: 1 }}>
        <StatusBar style={theme.isDark ? "light" : "dark"} />

        {/* Header */}
        <Header
          options={{
            title: t('Explore'),
            rightComponents: [
              <TouchableOpacity
                key="search"
                onPress={() => router.push('/search')}
                style={{ padding: 8 }}
              >
                <Ionicons name="search-outline" size={24} color={theme.colors.textSecondary} />
              </TouchableOpacity>,
            ],
          }}
        />

        {/* Tab Navigation */}
        <AnimatedTabBar
          tabs={[
            { id: 'all', label: t('All') },
            { id: 'media', label: t('Media') },
            { id: 'trending', label: t('Trending') },
            { id: 'custom', label: t('Custom') },
          ]}
          activeTabId={activeTab}
          onTabPress={(id) => setActiveTab(id as ExploreTab)}
        />

        {/* Content */}
        {renderContent()}
      </ThemedView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default ExploreScreen;