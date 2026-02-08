import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth, useFollow } from '@oxyhq/services';

import { useTheme } from '@/hooks/useTheme';

export default function FollowingScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const userId = user?.id ?? user?._id ?? '';
  const { followingCount = 0 } = useFollow(userId) as any;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Following</Text>
        <View style={styles.backButton} />
      </View>
      <View style={styles.content}>
        <Text style={[styles.countText, { color: theme.colors.text }]}>{followingCount}</Text>
        <Text style={[styles.countLabel, { color: theme.colors.textSecondary }]}>Following</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  backButton: { width: 32 },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 80,
  },
  countText: {
    fontSize: 48,
    fontWeight: '800',
  },
  countLabel: {
    fontSize: 16,
    marginTop: 4,
  },
});
