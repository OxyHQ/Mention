import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@oxyhq/services';

import { useTheme } from '@/hooks/useTheme';
import Avatar from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';

export default function ProfileScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const router = useRouter();

  const displayName = typeof user?.name === 'object'
    ? user?.name?.full || user?.name?.first
    : user?.name || user?.username || 'User';

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Profile</Text>
        <TouchableOpacity onPress={() => router.push('/(app)/settings')}>
          <Ionicons name="settings-outline" size={24} color={theme.colors.text} />
        </TouchableOpacity>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scrollContent}>
        <View style={styles.profileSection}>
          <Avatar source={user?.avatar} size={80} />
          <Text style={[styles.name, { color: theme.colors.text }]}>{displayName}</Text>
          {user?.username && (
            <Text style={[styles.username, { color: theme.colors.textSecondary }]}>
              @{user.username}
            </Text>
          )}
          {user?.bio && (
            <Text style={[styles.bio, { color: theme.colors.textSecondary }]}>
              {user.bio}
            </Text>
          )}
        </View>

        <EmptyState
          animation={require('@/assets/lottie/onair.json')}
          title="No hosted spaces"
          subtitle="Your hosted spaces will appear here"
        />
      </ScrollView>
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
  headerTitle: { fontSize: 28, fontWeight: '800' },
  scrollContent: { paddingBottom: 100 },
  profileSection: {
    alignItems: 'center',
    paddingTop: 32,
    paddingHorizontal: 16,
    gap: 4,
  },
  name: { fontSize: 22, fontWeight: '700', marginTop: 12 },
  username: { fontSize: 15 },
  bio: { fontSize: 14, textAlign: 'center', marginTop: 8, lineHeight: 20 },
});
