import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';
import React, { useCallback, useEffect, useMemo } from 'react';
import { TouchableOpacity, type ViewStyle } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiCustomerServiceLine } from '@oxy.so/bloom/icons/RiCustomerServiceLine';
import { useAuth } from '@oxy.so/services/ui/client';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';

import { BaseWidget } from './BaseWidget';
import { WidgetItemMenu, type WidgetItemMenuActions } from './WidgetItemMenu';
import { useColorTokens, useTheme } from '@oxy.so/bloom/theme';
import type { Room } from '@/lib/syraApi';
import { useLiveRoomsStore } from '@/stores/liveRoomsStore';
import { useUserById } from '@/hooks/useCachedUser';
import { shareLink } from '@/utils/shareLink';
import { WEB_BASE_URL } from '@/config';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { LIVE_INDICATOR_COLOR } from '@/styles/colors';

import {
  Embed,
  HStack,
  Icon,
  Text as LText,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';

const liveColors = defineTokens({ color: { LIVE_INDICATOR_COLOR } });

// A room row stays React Native's TouchableOpacity (the language has no node for its
// fading press; it is a pointer on the web already); this draws its classes.
const roomRow: ViewStyle = { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 };

const MAX_ROOMS_DISPLAYED = 3;
const LIVE_ROOMS_ROUTE = '/live-rooms';

function buildRoomUrl(roomId: string): string {
  return `${WEB_BASE_URL}/live-rooms/${roomId}`;
}

function getDisplayName(profile: ReturnType<typeof useUserById>, userId: string): string {
  return profile?.name?.displayName || profile?.username || userId.slice(0, 10);
}

const RoomRow = React.memo(function RoomRow({
  room,
  isLast,
  onPress,
  getMenuActions,
}: {
  room: Room;
  isLast: boolean;
  onPress: () => void;
  getMenuActions: (room: Room) => WidgetItemMenuActions;
}) {
  const colors = useColorTokens();
  const hostProfile = useUserById(room.host);
  const hostName = hostProfile?.username
    ? `@${hostProfile.username}`
    : getDisplayName(hostProfile, room.host);
  const listenerCount = room.participants?.length || 0;

  return (
    <TouchableOpacity
      style={[roomRow, !isLast && { borderBottomWidth: 0.5, borderColor: colors.border }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      {toElement(
        HStack(
          VStack()
            .frame({ width: '6', height: '6' })
            .background(liveColors.color.LIVE_INDICATOR_COLOR)
            .corner('infinite'),
          VStack(
            LText(room.title).font('body-2').weight('bold').lines(1),
            HStack(
              Icon(RiCustomerServiceLine).size('11').foreground('muted'),
              LText(listenerCount, ' listening · ', hostName)
                .grow()
                .foreground('muted')
                .font('caption-2')
                .lines(1),
            )
              .align('center')
              .spacing('xs')
              .margin('top', '1'),
          ).flex('1'),
        )
          .flex('1')
          .align('center')
          .spacing('sm'),
      )}
      <WidgetItemMenu label={room.title} {...getMenuActions(room)} />
    </TouchableOpacity>
  );
});

export function LiveRoomsWidget({ divider }: { divider?: boolean }) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const theme = useTheme();

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

  const displayedRooms = useMemo(() => visibleRooms.slice(0, MAX_ROOMS_DISPLAYED), [visibleRooms]);

  const handleShowMore = useCallback(() => {
    router.push(LIVE_ROOMS_ROUTE);
  }, [router]);

  const getMenuActions = useCallback(
    (room: Room) => {
      return {
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
      };
    },
    [hideRoom, t],
  );

  // Same settling rule as `TrendsWidget`.
  const hasSettled = hasFetched || error !== null;

  if (!isAuthenticated) return null;
  if (hasSettled && visibleRooms.length === 0) return null;

  return (
    <BaseWidget
      title="Live Rooms"
      icon={toElement(Icon(RiBroadcastLine).size('sm').foreground('foreground'))}
      divider={divider}
    >
      {!hasSettled
        ? toElement(
            VStack(
              Embed(
                Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton.Row key={i} style={{ alignItems: 'center', gap: 8 }}>
                    <Skeleton.Circle size={6} />
                    <Skeleton.Col>
                      <Skeleton.Text style={{ fontSize: 13, lineHeight: 15, width: 180 }} />
                      <Skeleton.Text style={{ fontSize: 11, lineHeight: 13, width: 140 }} />
                    </Skeleton.Col>
                  </Skeleton.Row>
                )),
              ),
            )
              .padding('vertical', 'xs')
              .spacing('10'),
          )
        : toElement(
            VStack(
              VStack(
                Embed(
                  displayedRooms.map((room, index) => (
                    <RoomRow
                      key={room._id}
                      room={room}
                      isLast={index === displayedRooms.length - 1}
                      onPress={() =>
                        router.push({
                          pathname: '/live-rooms/live/[id]',
                          params: { id: room._id },
                        })
                      }
                      getMenuActions={getMenuActions}
                    />
                  )),
                ),
              ),
              Embed(
                <Button
                  appearance="plain"
                  size="sm"
                  onPress={handleShowMore}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {t('common.showMore')}
                </Button>,
              ),
            ).spacing('sm'),
          )}
    </BaseWidget>
  );
}
