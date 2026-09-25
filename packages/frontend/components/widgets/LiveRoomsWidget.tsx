import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import React, { useCallback, useEffect, useMemo } from 'react';
import { TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiCustomerServiceLine } from '@oxy.so/bloom/icons/RiCustomerServiceLine';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { useAuth } from '@oxy.so/services/ui/client';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';

import { BaseWidget } from './BaseWidget';
import { useTheme } from '@oxy.so/bloom/theme';
import type { Room } from '@/lib/syraApi';
import { useLiveRoomsStore } from '@/stores/liveRoomsStore';
import { useUserById } from '@/hooks/useCachedUser';
import { useWidgetItemMenu } from '@/hooks/useWidgetItemMenu';
import { shareLink } from '@/utils/shareLink';
import { WEB_BASE_URL } from '@/config';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { LIVE_INDICATOR_COLOR } from '@/styles/colors';
import { HIT_SLOP_LG } from '@/styles/hitSlop';

const MAX_ROOMS_DISPLAYED = 3;
const LIVE_ROOMS_ROUTE = '/live-rooms';

function buildRoomUrl(roomId: string): string {
  return `${WEB_BASE_URL}/live-rooms/${roomId}`;
}

function getDisplayName(
  profile: ReturnType<typeof useUserById>,
  userId: string,
): string {
  return profile?.name?.displayName || profile?.username || userId.slice(0, 10);
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
      className={`flex-row items-center py-1.5 web:cursor-pointer ${!isLast ? 'border-b-[0.5px] border-border' : ''}`}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View className="flex-1 flex-row items-center gap-2">
        <View
          className="w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: LIVE_INDICATOR_COLOR }}
        />
        <View className="flex-1">
          <Text variant="body-2-bold" numberOfLines={1}>
            {room.title}
          </Text>
          <View className="flex-row items-center gap-1 mt-px">
            <RiCustomerServiceLine width={11} height={11} fill={theme.colors.textSecondary} />
            <Text
              variant="caption-2-regular"
              style={{ flex: 1, color: theme.colors.textSecondary }}
              numberOfLines={1}
            >
              {listenerCount} listening  ·  {hostName}
            </Text>
          </View>
        </View>
      </View>
      <TouchableOpacity
        className="p-1 web:cursor-pointer"
        onPress={() => onMenuPress(room)}
        hitSlop={HIT_SLOP_LG}
        accessibilityLabel="More options"
        accessibilityRole="button"
      >
        <RiMoreFill size="sm" fill={theme.colors.textSecondary} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
});

export function LiveRoomsWidget({ divider }: { divider?: boolean }) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const theme = useTheme();
  const openWidgetMenu = useWidgetItemMenu();

  const { rooms, hasFetched, error, hiddenRoomIds, startPolling, stopPolling, hideRoom } =
    useLiveRoomsStore();

  useEffect(() => {
    if (!isAuthenticated) return;
    const subscriptionId = startPolling();
    return () => stopPolling(subscriptionId);
  }, [isAuthenticated, startPolling, stopPolling]);

  const visibleRooms = useMemo(
    () => rooms.filter((room) => !hiddenRoomIds.includes(room._id)),
    [rooms, hiddenRoomIds],
  );

  const displayedRooms = useMemo(
    () => visibleRooms.slice(0, MAX_ROOMS_DISPLAYED),
    [visibleRooms],
  );

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

  // Same settling rule as `TrendsWidget`.
  const hasSettled = hasFetched || error !== null;

  if (!isAuthenticated) return null;
  if (hasSettled && visibleRooms.length === 0) return null;

  return (
    <BaseWidget
      title="Live Rooms"
      icon={<RiBroadcastLine size="sm" fill={theme.colors.text} />}
      divider={divider}
    >
      {!hasSettled ? (
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
      ) : (
        <View className="gap-2">
          <View>
            {displayedRooms.map((room, index) => (
              <RoomRow
                key={room._id}
                room={room}
                isLast={index === displayedRooms.length - 1}
                onPress={() => router.push({
                  pathname: '/live-rooms/live/[id]',
                  params: { id: room._id },
                })}
                onMenuPress={handleMenuPress}
              />
            ))}
          </View>
          <Button appearance="plain" size="small" onPress={handleShowMore} style={{ alignSelf: 'flex-start' }}>
            {t('Show more')}
          </Button>
        </View>
      )}
    </BaseWidget>
  );
}
