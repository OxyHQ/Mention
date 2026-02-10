import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@oxyhq/services';

import { BaseWidget } from './BaseWidget';
import { useTheme } from '@/hooks/useTheme';
import { useLiveRoom } from '@/context/LiveSpaceContext';
import { roomsService, type Room } from '@/services/spacesService';
import { useRoomUsers, getDisplayName } from '@/hooks/useSpaceUsers';
import { useUserById } from '@/stores/usersStore';
import { Agora as SpacesIcon } from '@mention/agora-shared';
import { Loading } from '@/components/ui/Loading';

const MAX_ROOMS_DISPLAYED = 3;
const REFRESH_INTERVAL_MS = 30_000;

const RoomRow = React.memo(function RoomRow({
  room,
  isLast,
  onPress,
}: {
  room: Room;
  isLast: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const hostProfile = useUserById(room.host);
  const hostName = hostProfile?.username
    ? `@${hostProfile.username}`
    : getDisplayName(hostProfile, room.host);
  const listenerCount = room.participants?.length || 0;

  return (
    <TouchableOpacity
      style={[
        styles.roomItem,
        !isLast && { borderBottomWidth: 0.5, borderBottomColor: theme.colors.border },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.roomContent}>
        <View style={styles.liveDot} />
        <View style={styles.roomTextContainer}>
          <Text
            style={[styles.roomTitle, { color: theme.colors.text }]}
            numberOfLines={1}
          >
            {room.title}
          </Text>
          <View style={styles.roomMeta}>
            <Ionicons name="headset-outline" size={11} color={theme.colors.textSecondary} />
            <Text style={[styles.roomMetaText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              {listenerCount} listening  ·  {hostName}
            </Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
});

export function LiveRoomsWidget() {
  const { isAuthenticated } = useAuth();
  const theme = useTheme();
  const router = useRouter();
  const { joinLiveRoom } = useLiveRoom();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLiveRooms = useCallback(async (silent = false) => {
    if (!isAuthenticated) return;
    if (!silent) {
      setIsLoading(true);
      setError(null);
    }
    try {
      const liveRooms = await roomsService.getRooms('live');
      setRooms(liveRooms);
      if (!silent) setIsLoading(false);
    } catch (err: any) {
      if (!silent) {
        setError(err?.message || 'Failed to load live rooms');
        setIsLoading(false);
      }
    }
  }, [isAuthenticated]);

  useEffect(() => {
    let mounted = true;

    const fetch = async (silent = false) => {
      if (!isAuthenticated) return;
      if (!silent) {
        setIsLoading(true);
        setError(null);
      }
      try {
        const liveRooms = await roomsService.getRooms('live');
        if (mounted) {
          setRooms(liveRooms);
          if (!silent) setIsLoading(false);
        }
      } catch (err: any) {
        if (mounted && !silent) {
          setError(err?.message || 'Failed to load live rooms');
          setIsLoading(false);
        }
      }
    };

    fetch();
    const id = setInterval(() => fetch(true), REFRESH_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [isAuthenticated]);

  const displayedRooms = useMemo(
    () => rooms.slice(0, MAX_ROOMS_DISPLAYED),
    [rooms],
  );

  const hostIds = useMemo(
    () => displayedRooms.map((r) => r.host).filter(Boolean),
    [displayedRooms],
  );
  useRoomUsers(hostIds);

  const handleShowMore = useCallback(() => {
    router.push('/agora' as any);
  }, [router]);

  if (!isAuthenticated) return null;
  if (!isLoading && !error && rooms.length === 0) return null;

  return (
    <BaseWidget
      title="Live Rooms"
      icon={<SpacesIcon size={18} color={theme.colors.text} />}
    >
      {isLoading ? (
        <View style={styles.centerRow}>
          <Loading size="small" style={{ flex: undefined }} />
          <Text style={[styles.muted, { color: theme.colors.textSecondary }]}>
            Loading rooms…
          </Text>
        </View>
      ) : error ? (
        <Text style={{ color: theme.colors.error }}>{error}</Text>
      ) : (
        <View style={styles.listContainer}>
          {displayedRooms.map((room, index) => (
            <RoomRow
              key={room._id}
              room={room}
              isLast={index === displayedRooms.length - 1}
              onPress={() => joinLiveRoom(room._id)}
            />
          ))}
          <TouchableOpacity
            style={styles.showMore}
            onPress={handleShowMore}
            activeOpacity={0.7}
          >
            <Text style={[styles.showMoreText, { color: theme.colors.primary }]}>
              Show more
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </BaseWidget>
  );
}

const styles = StyleSheet.create({
  centerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  muted: {
    fontSize: 13,
  },
  listContainer: {},
  roomItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    ...Platform.select({ web: { cursor: 'pointer' as const } }),
  },
  roomContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FF4458',
  },
  roomTextContainer: {
    flex: 1,
  },
  roomTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  roomMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 1,
  },
  roomMetaText: {
    fontSize: 12,
    flex: 1,
  },
  showMore: {
    ...Platform.select({ web: { cursor: 'pointer' as const } }),
  },
  showMoreText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
