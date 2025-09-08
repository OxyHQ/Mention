import React, { useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { shadowStyle } from '@/utils/platformStyles';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import { StatusBar } from 'expo-status-bar';
import Feed from '../components/Feed/Feed';

type ExploreTab = 'all' | 'media' | 'trending' | 'custom';

const ExploreScreen: React.FC = () => {
  const { t } = useTranslation();
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
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ThemedView style={{ flex: 1 }}>
        <StatusBar style="dark" />

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{t('Explore')}</Text>
        </View>

        {/* Tab Navigation */}
        <View style={styles.tabsContainer}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'all' && styles.activeTab]}
            onPress={() => setActiveTab('all')}
          >
            <Text style={[styles.tabText, activeTab === 'all' && styles.activeTabText]}>
              {t('All')}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tab, activeTab === 'media' && styles.activeTab]}
            onPress={() => setActiveTab('media')}
          >
            <Text style={[styles.tabText, activeTab === 'media' && styles.activeTabText]}>
              📸 {t('Media')}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tab, activeTab === 'trending' && styles.activeTab]}
            onPress={() => setActiveTab('trending')}
          >
            <Text style={[styles.tabText, activeTab === 'trending' && styles.activeTabText]}>
              🔥 {t('Trending')}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tab, activeTab === 'custom' && styles.activeTab]}
            onPress={() => setActiveTab('custom')}
          >
            <Text style={[styles.tabText, activeTab === 'custom' && styles.activeTabText]}>
              🎯 {t('Custom')}
            </Text>
          </TouchableOpacity>
        </View>

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
  header: {
    paddingVertical: 16,
    paddingHorizontal: 16,
    backgroundColor: 'white',
    borderBottomWidth: 0.5,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    ...shadowStyle({ elevation: 1, web: `0px 1px 4px ${colors.shadow}` }),
    // sticky header on web
    ...(Platform.OS === 'web' ? ({ position: 'sticky' as any, top: 0, zIndex: 1000 } as any) : {}),
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.COLOR_BLACK_LIGHT_1,
  },
  tabsContainer: {
    flexDirection: 'row',
    backgroundColor: 'white',
    borderBottomWidth: 0.5,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 4,
  },
  activeTab: {
    borderBottomWidth: 3,
    borderBottomColor: colors.primaryColor,
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.COLOR_BLACK_LIGHT_3,
    textAlign: 'center',
  },
  activeTabText: {
    color: colors.primaryColor,
    fontWeight: 'bold',
  },
});

export default ExploreScreen;