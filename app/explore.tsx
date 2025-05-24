import React from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import Feed from '@/components/Feed';
import { PostProvider } from '@/context/PostContext';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import { StatusBar } from 'expo-status-bar';

const ExploreScreen: React.FC = () => {
  const { t } = useTranslation();

  return (
    <PostProvider>
      <SafeAreaView style={styles.container}>
        <StatusBar style="dark" />
        <View style={styles.header}>
          <Text style={styles.headerTitle}>{t('Explore')}</Text>
        </View>
        <Feed showCreatePost type="all" />
      </SafeAreaView>
    </PostProvider>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.COLOR_BLACK_LIGHT_8,
  },
  header: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 0.5,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: colors.COLOR_BLACK_LIGHT_1,
  },
});

export default ExploreScreen;