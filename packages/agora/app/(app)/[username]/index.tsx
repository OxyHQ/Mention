import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, Alert } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth, useFollowerCounts } from '@oxyhq/services';
import { useLiveRoom, RoomCard } from '@mention/agora-shared';
import type { Room } from '@mention/agora-shared';

import { toast } from 'sonner-native';
import { useTheme } from '@/hooks/useTheme';
import { useUserSpaces, useSpacesQueryInvalidation, useDeleteSpace, useArchiveSpace } from '@/hooks/useSpacesQuery';
import Avatar from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { ProfileTabBar } from '@/components/ProfileTabBar';

const TABS = [
  { id: 'spaces', label: 'Spaces' },
  { id: 'live', label: 'Live' },
  { id: 'scheduled', label: 'Scheduled' },
];

export default function ProfileScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const router = useRouter();
  const { username } = useLocalSearchParams<{ username: string }>();
  const { joinLiveRoom } = useLiveRoom();

  const navigation = useNavigation();
  const canGoBack = navigation.canGoBack();

  const cleanUsername = username?.startsWith('@') ? username.slice(1) : username || '';
  const isOwnProfile = cleanUsername === user?.username;
  const userId = user?.id ?? '';
  const { followerCount, followingCount } = useFollowerCounts(userId);

  const [activeTab, setActiveTab] = useState('spaces');

  const { data: mySpaces = { all: [], live: [], scheduled: [] }, isRefetching } = useUserSpaces(userId || undefined);
  const { invalidateUserSpaces } = useSpacesQueryInvalidation();
  const refreshing = isRefetching;
  const onRefresh = () => { invalidateUserSpaces(userId); };

  const deleteSpace = useDeleteSpace();
  const archiveSpace = useArchiveSpace();

  const handleSpaceActions = (space: Room) => {
    const isLive = space.status === 'live';
    const actions: { text: string; style?: 'destructive' | 'cancel' | 'default'; onPress?: () => void }[] = [];

    if (!isLive) {
      actions.push({
        text: space.archived ? 'Unarchive' : 'Archive',
        onPress: () => {
          archiveSpace.mutate(
            { id: space._id, userId },
            {
              onSuccess: (data) => {
                toast(data.archived ? 'Space archived' : 'Space unarchived');
              },
              onError: () => {
                toast('Failed to update space');
              },
            },
          );
        },
      });
      actions.push({
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          Alert.alert(
            'Delete Space',
            'Are you sure? This cannot be undone.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () =>
                  deleteSpace.mutate(
                    { id: space._id, userId },
                    {
                      onSuccess: () => {
                        toast('Space deleted');
                      },
                      onError: () => {
                        toast('Failed to delete space');
                      },
                    },
                  ),
              },
            ],
          );
        },
      });
    }

    actions.push({ text: 'Cancel', style: 'cancel' });

    Alert.alert('Space Options', undefined, actions);
  };

  const displayName = typeof user?.name === 'object'
    ? user?.name?.full || user?.name?.first
    : user?.name || user?.username || 'User';

  const handleJoinSpace = (space: Room) => {
    joinLiveRoom(space._id);
  };

  const currentSpaces =
    activeTab === 'live' ? mySpaces.live
      : activeTab === 'scheduled' ? mySpaces.scheduled
        : mySpaces.all;

  const emptyMessages: Record<string, { title: string; subtitle: string }> = {
    spaces: { title: 'No spaces yet', subtitle: 'Your hosted spaces will appear here' },
    live: { title: 'No live spaces', subtitle: 'Your live spaces will appear here' },
    scheduled: { title: 'No scheduled spaces', subtitle: 'Your scheduled spaces will appear here' },
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.colors.border }]}>
        {canGoBack ? (
          <TouchableOpacity
            onPress={() => {
              if (isOwnProfile) {
                // Navigate to home tab directly to avoid redirect loop
                // (the (tabs)/profile screen has a <Redirect> that would send us right back)
                router.replace('/(app)/(tabs)');
              } else {
                router.back();
              }
            }}
            style={styles.backButton}
          >
            <MaterialCommunityIcons name="arrow-left" size={24} color={theme.colors.text} />
          </TouchableOpacity>
        ) : (
          <View style={styles.backButton} />
        )}
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>@{cleanUsername}</Text>
        <TouchableOpacity onPress={() => router.push('/(app)/settings')}>
          <MaterialCommunityIcons name="cog-outline" size={24} color={theme.colors.text} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />}
      >
        <View style={styles.profileSection}>
          <View style={styles.avatarWrapper}>
            {mySpaces.live.length > 0 && (
              <View style={styles.liveRing} />
            )}
            <Avatar source={user?.avatar} size={80} />
            {mySpaces.live.length > 0 && (
              <View style={styles.liveBadge}>
                <Text style={styles.liveBadgeText}>LIVE</Text>
              </View>
            )}
          </View>
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

        {/* Stats Row */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, { color: theme.colors.text }]}>{mySpaces.all.length}</Text>
            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Spaces</Text>
          </View>
          <TouchableOpacity style={styles.statItem} onPress={() => router.push({ pathname: '/(app)/[username]/followers', params: { username: '@' + cleanUsername } })}>
            <Text style={[styles.statNumber, { color: theme.colors.text }]}>{followerCount}</Text>
            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Followers</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.statItem} onPress={() => router.push({ pathname: '/(app)/[username]/following', params: { username: '@' + cleanUsername } })}>
            <Text style={[styles.statNumber, { color: theme.colors.text }]}>{followingCount}</Text>
            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Following</Text>
          </TouchableOpacity>
        </View>

        {/* Edit Profile Button */}
        {isOwnProfile && (
          <TouchableOpacity
            style={[styles.editButton, { borderColor: theme.colors.border }]}
            onPress={() => router.push('/(app)/settings')}
          >
            <Text style={[styles.editButtonText, { color: theme.colors.text }]}>Edit Profile</Text>
          </TouchableOpacity>
        )}

        {/* Tab Bar */}
        <ProfileTabBar tabs={TABS} activeTab={activeTab} onTabPress={setActiveTab} />

        {/* Tab Content */}
        {currentSpaces.length > 0 ? (
          <View style={styles.spacesContainer}>
            {currentSpaces.map((space) => (
              <View key={space._id} style={{ position: 'relative' }}>
                <RoomCard
                  room={space}
                  onPress={() => handleJoinSpace(space)}
                />
                {isOwnProfile && (
                  <TouchableOpacity
                    onPress={() => handleSpaceActions(space)}
                    style={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      width: 32,
                      height: 32,
                      borderRadius: 16,
                      backgroundColor: theme.colors.backgroundSecondary,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <MaterialCommunityIcons name="dots-vertical" size={18} color={theme.colors.textSecondary} />
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </View>
        ) : (
          <EmptyState
            animation={require('@/assets/lottie/onair.json')}
            title={emptyMessages[activeTab].title}
            subtitle={emptyMessages[activeTab].subtitle}
          />
        )}
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
  backButton: { width: 32 },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  scrollContent: { paddingBottom: 100 },
  profileSection: {
    alignItems: 'center',
    paddingTop: 32,
    paddingHorizontal: 16,
    gap: 4,
  },
  avatarWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveRing: {
    position: 'absolute',
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 3,
    borderColor: '#FF4458',
  },
  liveBadge: {
    position: 'absolute',
    bottom: -6,
    backgroundColor: '#FF4458',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  liveBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  name: { fontSize: 22, fontWeight: '700', marginTop: 12 },
  username: { fontSize: 15 },
  bio: { fontSize: 14, textAlign: 'center', marginTop: 8, lineHeight: 20 },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 20,
    marginBottom: 16,
    gap: 32,
  },
  statItem: {
    alignItems: 'center',
  },
  statNumber: {
    fontSize: 18,
    fontWeight: '700',
  },
  statLabel: {
    fontSize: 13,
    marginTop: 2,
  },
  editButton: {
    alignSelf: 'center',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 24,
    paddingVertical: 8,
    marginBottom: 20,
  },
  editButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  spacesContainer: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
});
