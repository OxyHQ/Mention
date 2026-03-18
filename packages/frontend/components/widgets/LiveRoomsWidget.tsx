import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@oxyhq/services';

import { BaseWidget } from './BaseWidget';
import { useTheme } from '@oxyhq/bloom/theme';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { roomsService, type Room } from '@/services/roomsService';
import { useRoomUsers, getDisplayName } from '@/hooks/useRoomUsers';
import { useUserById } from '@/stores/usersStore';
import { Agora as AgoraIcon } from '@mention/agora-shared';
import * as Skeleton from '@oxyhq/bloom/skeleton';

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
      className={`flex-row items-center py-2 ${!isLast ? "border-border" : ""}`}
      style={[
        styles.webCursor,
        !isLast && styles.itemBorder,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View className="flex-1 flex-row items-center gap-2">
        <View className="w-1.5 h-1.5 rounded-full bg-[#FF4458]" />
        <View className="flex-1">
          <Text
            className="text-foreground text-[13px] font-bold"
            numberOfLines={1}
          >
            {room.title}
          </Text>
          <View className="flex-row items-center gap-1 mt-px">
            <Ionicons name="headset-outline" size={11} color={theme.colors.textSecondary} />
            <Text className="text-muted-foreground text-[11px] flex-1" numberOfLines={1}>
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
      icon={<AgoraIcon size={16} className="text-foreground" />}
    >
      {isLoading ? (
        <View className="gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton.Row key={i} style={{ alignItems: 'center', gap: 8 }}>
              <Skeleton.Circle size={6} />
              <Skeleton.Col>
                <Skeleton.Text style={{ fontSize: 13, lineHeight: 15, width: 180 }} />
                <Skeleton.Text style={{ fontSize: 11, lineHeight: 13, width: 140 }} />
              </Skeleton.Col>
            </Skeleton.Row>
          ))}
        </View>
      ) : error ? (
        <Text className="text-destructive">{error}</Text>
      ) : (
        <View>
          {displayedRooms.map((room, index) => (
            <RoomRow
              key={room._id}
              room={room}
              isLast={index === displayedRooms.length - 1}
              onPress={() => joinLiveRoom(room._id)}
            />
          ))}
          <TouchableOpacity
            className="pt-2 pb-1"
            style={styles.webCursor}
            onPress={handleShowMore}
            activeOpacity={0.7}
          >
            <Text className="text-primary text-[14px] font-medium">
              Show more
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </BaseWidget>
  );
}

const styles = StyleSheet.create({
  webCursor: Platform.select({ web: { cursor: 'pointer' }, default: {} }),
  itemBorder: { borderBottomWidth: 0.5 },
});
