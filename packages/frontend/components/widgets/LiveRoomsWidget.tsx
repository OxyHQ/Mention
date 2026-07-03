import React, { useCallback, useEffect, useMemo } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@oxyhq/services';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTranslation } from 'react-i18next';

import { BaseWidget } from './BaseWidget';
import { useTheme } from '@oxyhq/bloom/theme';
import { useLiveRoom } from '@/context/LiveRoomContext';
import type { Room } from '@syra.fm/live';
import { useLiveRoomsStore } from '@/stores/liveRoomsStore';
import { useRoomUsers, getDisplayName } from '@/hooks/useRoomUsers';
import { useUserById } from '@/hooks/useCachedUser';
import { useWidgetItemMenu } from '@/hooks/useWidgetItemMenu';
import { shareLink } from '@/utils/shareLink';
import { WEB_BASE_URL } from '@/config';
import { LiveRoomsIcon } from '@syra.fm/live';
import * as Skeleton from '@oxyhq/bloom/skeleton';

const MAX_ROOMS_DISPLAYED = 3;
const LIVE_ROOMS_ROUTE = '/live-rooms';

function buildRoomUrl(roomId: string): string {
  return `${WEB_BASE_URL}/live-rooms/${roomId}`;
}

const RoomRow = React.memo(function RoomRow({
  room,
  isLast,
  onPress,
  onMenuPress,
}: {
  room: Room;
  isLast: boolean;
  onPress: () => void;
  onMenuPress: (room: Room) => void;
}) {
  const theme = useTheme();
  const hostProfile = useUserById(room.host);
  const hostName = hostProfile?.username
    ? `@${hostProfile.username}`
    : getDisplayName(hostProfile, room.host);
  const listenerCount = room.participants?.length || 0;

  return (
    <TouchableOpacity
      className={`flex-row items-center py-1.5 ${!isLast ? "border-border" : ""}`}
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
      <TouchableOpacity
        className="p-1"
        style={styles.webCursor}
        onPress={() => onMenuPress(room)}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityLabel="More options"
        accessibilityRole="button"
      >
        <Ionicons name="ellipsis-horizontal" size={16} color={theme.colors.textSecondary} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
});

export function LiveRoomsWidget() {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const theme = useTheme();
  const { joinLiveRoom } = useLiveRoom();
  const openWidgetMenu = useWidgetItemMenu();

  const { rooms, isLoading, hasFetched, error, hiddenRoomIds, startPolling, stopPolling, hideRoom } =
    useLiveRoomsStore();

  useEffect(() => {
    if (!isAuthenticated) return;
    startPolling();
    return () => stopPolling();
  }, [isAuthenticated, startPolling, stopPolling]);

  const visibleRooms = useMemo(
    () => rooms.filter((room) => !hiddenRoomIds.includes(room._id)),
    [rooms, hiddenRoomIds],
  );

  const displayedRooms = useMemo(
    () => visibleRooms.slice(0, MAX_ROOMS_DISPLAYED),
    [visibleRooms],
  );

  const hostIds = useMemo(
    () => displayedRooms.map((r) => r.host).filter(Boolean),
    [displayedRooms],
  );
  useRoomUsers(hostIds);

  const handleShowMore = useCallback(() => {
    router.push(LIVE_ROOMS_ROUTE);
  }, [router]);

  const handleMenuPress = useCallback(
    (room: Room) => {
      openWidgetMenu({
        title: room.title,
        onNotInterested: () => {
          hideRoom(room._id);
          toast(t('widgetMenu.roomHidden'), { type: 'success' });
        },
        onShare: () => {
          void shareLink({
            title: room.title,
            url: buildRoomUrl(room._id),
            copiedToast: t('widgetMenu.linkCopied'),
            errorToast: t('widgetMenu.shareFailed'),
          });
        },
      });
    },
    [openWidgetMenu, hideRoom, t],
  );

  if (!isAuthenticated) return null;
  if (hasFetched && !error && visibleRooms.length === 0) return null;

  return (
    <BaseWidget
      title="Live Rooms"
      icon={<LiveRoomsIcon size={16} color={theme.colors.text} />}
    >
      {isLoading && !hasFetched ? (
        <View className="gap-2.5 py-1">
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
        <View className="gap-2">
          <View>
            {displayedRooms.map((room, index) => (
              <RoomRow
                key={room._id}
                room={room}
                isLast={index === displayedRooms.length - 1}
                onPress={() => joinLiveRoom(room._id)}
                onMenuPress={handleMenuPress}
              />
            ))}
          </View>
          <TouchableOpacity
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
