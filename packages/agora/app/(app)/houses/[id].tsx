import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Image,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@oxyhq/services';
import { RoomCard, useLiveRoom } from '@mention/agora-shared';
import type { HouseMember } from '@mention/agora-shared';

import { useTheme } from '@/hooks/useTheme';
import { useHouse, useHouseRooms } from '@/hooks/useRoomsQuery';
import { EmptyState } from '@/components/EmptyState';
import Avatar from '@/components/Avatar';
import { getCachedFileDownloadUrl } from '@/utils/imageUrlCache';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  host: 'Host',
};

export default function HouseScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { joinLiveRoom } = useLiveRoom();
  const { oxyServices } = useAuth();

  const { data: house, isLoading } = useHouse(id);
  const { data: rooms = [], isRefetching } = useHouseRooms(id);

  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    if (house?.avatar && oxyServices) {
      getCachedFileDownloadUrl(oxyServices, house.avatar).then(setAvatarUrl);
    }
  }, [house?.avatar, oxyServices]);

  const liveRooms = rooms.filter((r) => r.status === 'live');
  const scheduledRooms = rooms.filter((r) => r.status === 'scheduled');

  const { hosts, members } = useMemo(() => {
    if (!house) return { hosts: [], members: [] };
    const h: HouseMember[] = [];
    const m: HouseMember[] = [];
    for (const member of house.members) {
      if (member.role === 'owner' || member.role === 'admin' || member.role === 'host') {
        h.push(member);
      } else {
        m.push(member);
      }
    }
    return { hosts: h, members: m };
  }, [house]);

  if (isLoading) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (!house) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.background }]}>
        <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>House not found</Text>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={[styles.backLink, { color: theme.colors.primary }]}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <MaterialCommunityIcons name="arrow-left" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]} numberOfLines={1}>
          {house.name}
        </Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={isRefetching} tintColor={theme.colors.primary} />}
      >
        {/* House Info */}
        <View style={styles.infoSection}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: theme.colors.primary + '20' }]}>
              <Text style={[styles.avatarFallbackText, { color: theme.colors.primary }]}>
                {house.name.charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
          <Text style={[styles.name, { color: theme.colors.text }]}>{house.name}</Text>
          {house.description && (
            <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
              {house.description}
            </Text>
          )}

          {/* Meta row */}
          <View style={styles.metaRow}>
            <View style={styles.metaItem}>
              <MaterialCommunityIcons name="account-group" size={16} color={theme.colors.textSecondary} />
              <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                {house.members.length} {house.members.length === 1 ? 'member' : 'members'}
              </Text>
            </View>
            <View style={styles.metaItem}>
              <MaterialCommunityIcons
                name={house.isPublic ? 'earth' : 'lock'}
                size={16}
                color={theme.colors.textSecondary}
              />
              <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
                {house.isPublic ? 'Public' : 'Private'}
              </Text>
            </View>
          </View>

          {/* Tags */}
          {house.tags && house.tags.length > 0 && (
            <View style={styles.tagsRow}>
              {house.tags.map((tag) => (
                <View key={tag} style={[styles.tag, { backgroundColor: theme.colors.backgroundSecondary }]}>
                  <Text style={[styles.tagText, { color: theme.colors.textSecondary }]}>{tag}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Rooms */}
        {liveRooms.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.liveIndicator}>
                <View style={styles.liveDot} />
              </View>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Live Now</Text>
              <Text style={[styles.sectionCount, { color: theme.colors.textSecondary }]}>
                {liveRooms.length}
              </Text>
            </View>
            <View style={styles.roomsList}>
              {liveRooms.map((room) => (
                <RoomCard key={room._id} room={room} onPress={() => joinLiveRoom(room._id)} />
              ))}
            </View>
          </View>
        )}

        {scheduledRooms.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <MaterialCommunityIcons name="calendar" size={18} color={theme.colors.textSecondary} />
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Upcoming</Text>
              <Text style={[styles.sectionCount, { color: theme.colors.textSecondary }]}>
                {scheduledRooms.length}
              </Text>
            </View>
            <View style={styles.roomsList}>
              {scheduledRooms.map((room) => (
                <RoomCard
                  key={room._id}
                  room={room}
                  onPress={() => {
                    if (room.status === 'live') joinLiveRoom(room._id);
                  }}
                />
              ))}
            </View>
          </View>
        )}

        {liveRooms.length === 0 && scheduledRooms.length === 0 && (
          <EmptyState
            animation={require('@/assets/lottie/onair.json')}
            title="No rooms yet"
            subtitle="Rooms in this house will appear here"
          />
        )}

        {/* Hosts & Co-hosts */}
        {hosts.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <MaterialCommunityIcons name="account-star" size={18} color={theme.colors.textSecondary} />
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Hosts</Text>
            </View>
            <View style={styles.memberList}>
              {hosts.map((m) => (
                <View key={m.userId} style={styles.memberRow}>
                  <Avatar size={40} />
                  <View style={styles.memberInfo}>
                    <Text style={[styles.memberName, { color: theme.colors.text }]} numberOfLines={1}>
                      {m.userId}
                    </Text>
                    <Text style={[styles.memberRole, { color: theme.colors.primary }]}>
                      {ROLE_LABELS[m.role] || m.role}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Members */}
        {members.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <MaterialCommunityIcons name="account-multiple" size={18} color={theme.colors.textSecondary} />
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Members</Text>
              <Text style={[styles.sectionCount, { color: theme.colors.textSecondary }]}>
                {members.length}
              </Text>
            </View>
            <View style={styles.memberList}>
              {members.map((m) => (
                <View key={m.userId} style={styles.memberRow}>
                  <Avatar size={40} />
                  <View style={styles.memberInfo}>
                    <Text style={[styles.memberName, { color: theme.colors.text }]} numberOfLines={1}>
                      {m.userId}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  backButton: { width: 32 },
  headerTitle: { fontSize: 18, fontWeight: '700', flex: 1, textAlign: 'center', marginHorizontal: 8 },
  scrollContent: { paddingBottom: 100 },
  infoSection: {
    alignItems: 'center',
    paddingTop: 32,
    paddingHorizontal: 16,
    paddingBottom: 24,
    gap: 6,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
  },
  avatarFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarFallbackText: {
    fontSize: 32,
    fontWeight: '700',
  },
  name: { fontSize: 22, fontWeight: '700', marginTop: 12, textAlign: 'center' },
  description: { fontSize: 14, textAlign: 'center', lineHeight: 20, marginTop: 4 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    marginTop: 12,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metaText: { fontSize: 13 },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
  },
  tag: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  tagText: { fontSize: 12, fontWeight: '500' },
  section: { marginTop: 24 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  sectionCount: { fontSize: 14, fontWeight: '500' },
  liveIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FF4458',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  roomsList: { paddingHorizontal: 16 },
  memberList: {
    paddingHorizontal: 16,
    gap: 12,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  memberInfo: {
    flex: 1,
  },
  memberName: {
    fontSize: 14,
    fontWeight: '600',
  },
  memberRole: {
    fontSize: 12,
    fontWeight: '500',
    marginTop: 2,
  },
  errorText: { fontSize: 16, marginBottom: 12 },
  backLink: { fontSize: 15, fontWeight: '600' },
});
