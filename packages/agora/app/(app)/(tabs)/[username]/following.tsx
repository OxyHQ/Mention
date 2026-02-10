import { View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@oxyhq/services';
import type { UserEntity } from '@mention/agora-shared';

import { useTheme } from '@/hooks/useTheme';
import { useFollowingList } from '@/hooks/useRoomsQuery';
import Avatar from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';

export default function FollowingScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { username } = useLocalSearchParams<{ username: string }>();
  const { oxyServices, user } = useAuth();

  const cleanUsername = username?.startsWith('@') ? username.slice(1) : username || '';
  const isOwnProfile = cleanUsername === user?.username;

  const userId = isOwnProfile ? (user?.id ?? '') : cleanUsername;
  const { data: following = [], isLoading: loading } = useFollowingList(oxyServices, userId);

  const renderItem = ({ item }: { item: UserEntity }) => {
    const rawName = item?.name;
    const name =
      (typeof rawName === 'object' && rawName?.full) ||
      (typeof rawName === 'object' && rawName?.first ? `${rawName.first} ${rawName.last || ''}`.trim() : '') ||
      (typeof rawName === 'string' && rawName) ||
      item?.displayName ||
      item?.username ||
      'User';
    const handle = item?.username || item?.handle || '';

    return (
      <TouchableOpacity
        style={[styles.row, { borderBottomColor: theme.colors.border }]}
        onPress={() => handle && router.push({ pathname: '/(app)/(tabs)/[username]', params: { username: '@' + handle } })}
      >
        <Avatar source={item?.avatar} size={40} />
        <View style={styles.rowText}>
          <Text style={[styles.rowName, { color: theme.colors.text }]} numberOfLines={1}>
            {name}
          </Text>
          {handle ? (
            <Text style={[styles.rowHandle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              @{handle}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Following</Text>
        <View style={styles.backButton} />
      </View>

      {loading ? (
        <View style={styles.loadingState}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      ) : (
        <FlatList
          data={following}
          renderItem={renderItem}
          keyExtractor={(item: UserEntity) => item.id || item.username || ''}
          ListEmptyComponent={
            <EmptyState
              animation={require('@/assets/lottie/looking.json')}
              title="Not following anyone yet"
              subtitle="When this account follows people, they'll show up here"
            />
          }
          contentContainerStyle={following.length === 0 ? { flex: 1 } : undefined}
        />
      )}
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    gap: 12,
  },
  rowText: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: '600' },
  rowHandle: { fontSize: 13, marginTop: 1 },
  loadingState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
