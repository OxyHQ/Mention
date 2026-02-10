import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, Alert, Image } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter, useLocalSearchParams, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth, useFollowerCounts } from '@oxyhq/services';
import { useLiveRoom, RoomCard } from '@mention/agora-shared';
import type { Room, House } from '@mention/agora-shared';

import { toast } from 'sonner-native';
import { useTheme } from '@/hooks/useTheme';
import { useUserRooms, useUserHouses, useRoomsQueryInvalidation, useDeleteRoom, useArchiveRoom } from '@/hooks/useRoomsQuery';
import Avatar from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { ProfileTabBar } from '@/components/ProfileTabBar';
import { getCachedFileDownloadUrl } from '@/utils/imageUrlCache';

const TABS = [
  { id: 'rooms', label: 'Rooms' },
  { id: 'live', label: 'Live' },
  { id: 'scheduled', label: 'Scheduled' },
];

function HouseItem({ house, theme, onPress }: { house: House; theme: ReturnType<typeof useTheme>; onPress: () => void }) {
  const { oxyServices } = useAuth();
  const [avatarUrl, setAvatarUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (house.avatar && oxyServices) {
      getCachedFileDownloadUrl(oxyServices, house.avatar).then(setAvatarUrl);
    }
  }, [house.avatar, oxyServices]);

  return (
    <TouchableOpacity style={styles.houseItem} activeOpacity={0.7} onPress={onPress}>
      {avatarUrl ? (
        <Image source={{ uri: avatarUrl }} style={styles.houseAvatar} />
      ) : (
        <View style={[styles.houseAvatar, styles.houseAvatarFallback, { backgroundColor: theme.colors.primary + '20' }]}>
          <Text style={[styles.houseAvatarText, { color: theme.colors.primary }]}>
            {house.name.charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
      <Text style={[styles.houseItemName, { color: theme.colors.textSecondary }]} numberOfLines={1}>
        {house.name}
      </Text>
    </TouchableOpacity>
  );
}

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
  const { followerCount, followingCount, fetchUserCounts } = useFollowerCounts(userId);

  useEffect(() => {
    if (userId) fetchUserCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const [activeTab, setActiveTab] = useState('rooms');

  const { data: myRooms = { all: [], live: [], scheduled: [] }, isRefetching } = useUserRooms(userId || undefined);
  const { data: userHouses = [] } = useUserHouses(userId || undefined);
  const { invalidateUserRooms } = useRoomsQueryInvalidation();
  const refreshing = isRefetching;
  const onRefresh = () => { invalidateUserRooms(userId); };

  const deleteRoom = useDeleteRoom();
  const archiveRoom = useArchiveRoom();

  const handleRoomActions = (room: Room) => {
    const isLive = room.status === 'live';
    const actions: { text: string; style?: 'destructive' | 'cancel' | 'default'; onPress?: () => void }[] = [];

    if (!isLive) {
      actions.push({
        text: room.archived ? 'Unarchive' : 'Archive',
        onPress: () => {
          archiveRoom.mutate(
            { id: room._id, userId },
            {
              onSuccess: (data) => {
                toast(data.archived ? 'Room archived' : 'Room unarchived');
              },
              onError: () => {
                toast('Failed to update room');
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
            'Delete Room',
            'Are you sure? This cannot be undone.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () =>
                  deleteRoom.mutate(
                    { id: room._id, userId },
                    {
                      onSuccess: () => {
                        toast('Room deleted');
                      },
                      onError: () => {
                        toast('Failed to delete room');
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

    Alert.alert('Room Options', undefined, actions);
  };

  const displayName = typeof user?.name === 'object'
    ? user?.name?.full || user?.name?.first
    : user?.name || user?.username || 'User';

  const handleJoinRoom = (room: Room) => {
    joinLiveRoom(room._id);
  };

  const currentRooms =
    activeTab === 'live' ? myRooms.live
      : activeTab === 'scheduled' ? myRooms.scheduled
        : myRooms.all;

  const emptyMessages: Record<string, { title: string; subtitle: string }> = {
    rooms: { title: 'No rooms yet', subtitle: 'Your hosted rooms will appear here' },
    live: { title: 'No live rooms', subtitle: 'Your live rooms will appear here' },
    scheduled: { title: 'No scheduled rooms', subtitle: 'Your scheduled rooms will appear here' },
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
            {myRooms.live.length > 0 && (
              <View style={styles.liveRing} />
            )}
            <Avatar source={user?.avatar} size={80} />
            {myRooms.live.length > 0 && (
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
            <Text style={[styles.statNumber, { color: theme.colors.text }]}>{myRooms.all.length}</Text>
            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Rooms</Text>
          </View>
          <TouchableOpacity style={styles.statItem} onPress={() => router.push({ pathname: '/(app)/[username]/followers', params: { username: '@' + cleanUsername } })}>
            <Text style={[styles.statNumber, { color: theme.colors.text }]}>{followerCount ?? 0}</Text>
            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Followers</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.statItem} onPress={() => router.push({ pathname: '/(app)/[username]/following', params: { username: '@' + cleanUsername } })}>
            <Text style={[styles.statNumber, { color: theme.colors.text }]}>{followingCount ?? 0}</Text>
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

        {/* Member of */}
        {userHouses.length > 0 && (
          <View style={styles.housesSection}>
            <Text style={[styles.housesLabel, { color: theme.colors.textSecondary }]}>
              Member of
            </Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.housesList}
            >
              {userHouses.map((house) => (
                <HouseItem
                  key={house._id}
                  house={house}
                  theme={theme}
                  onPress={() => router.push({ pathname: '/(app)/houses/[id]', params: { id: house._id } })}
                />
              ))}
            </ScrollView>
          </View>
        )}

        {/* Tab Bar */}
        <ProfileTabBar tabs={TABS} activeTab={activeTab} onTabPress={setActiveTab} />

        {/* Tab Content */}
        {currentRooms.length > 0 ? (
          <View style={styles.roomsContainer}>
            {currentRooms.map((room) => (
              <View key={room._id} style={{ position: 'relative' }}>
                <RoomCard
                  room={room}
                  onPress={() => handleJoinRoom(room)}
                />
                {isOwnProfile && (
                  <TouchableOpacity
                    onPress={() => handleRoomActions(room)}
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
  housesSection: {
    paddingHorizontal: 16,
    marginBottom: 20,
  },
  housesLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  housesList: {
    gap: 16,
  },
  houseItem: {
    alignItems: 'center',
    width: 56,
  },
  houseAvatar: {
    width: 48,
    height: 48,
    borderRadius: 11,
    marginBottom: 4,
  },
  houseAvatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  houseAvatarText: {
    fontSize: 20,
    fontWeight: '700',
  },
  houseItemName: {
    fontSize: 10,
    textAlign: 'center',
  },
  roomsContainer: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
});
