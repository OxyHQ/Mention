import React, { useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View, TouchableOpacity, Platform } from 'react-native';
import Feed from '@/components/Feed';
import CustomFeed from '@/components/Feed/CustomFeed';
import { PostProvider } from '@/context/PostContext';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import { StatusBar } from 'expo-status-bar';

type ExploreTab = 'all' | 'media' | 'trending' | 'custom';

const ExploreScreen: React.FC = () => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<ExploreTab>('all');

  const renderContent = () => {
    switch (activeTab) {
      case 'media':
        return (
          <Feed
            type="custom"
            customOptions={{ mediaOnly: true }}
          />
        );

      case 'trending':
        return (
          <CustomFeed
            title={t('Trending')}
            initialFilters={{
              hashtags: ['trending', 'viral', 'popular'],
              users: [],
              keywords: [],
              mediaOnly: false
            }}
          />
        );

      case 'custom':
        return (
          <CustomFeed
            title={t('Create Your Discovery Feed')}
            initialFilters={{
              hashtags: [],
              users: [],
              keywords: [],
              mediaOnly: false
            }}
          />
        );

      default:
        return <Feed type="all" />;
    }
  };

  return (
    <PostProvider>
      <SafeAreaView style={styles.container}>
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
      </SafeAreaView>
    </PostProvider>
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
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 1,
    ...Platform.select({
      web: {
        position: 'sticky',
        top: 0,
        zIndex: 1000,
      },
    }),
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