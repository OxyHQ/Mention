import type React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from '@/lib/navigation/router';
import { useAuth } from '@oxy.so/services/ui/client';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiCalendarLine } from '@oxy.so/bloom/icons/RiCalendarLine';

import { EmptyState } from '@/components/common/EmptyState';
import { RoomsListSkeleton } from '@/components/rooms/RoomsListSkeleton';
import RoomCard from '@/components/RoomCard';
import { SEO } from '@/components/SEO';

import { useRoomUsers } from '@/hooks/useRoomUsers';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { roomsService, type Room } from '@/lib/syraApi';
import { logger } from '@oxy.so/core/logger';
import { presentSheet } from '@/utils/sheet';
import { useTranslation } from 'react-i18next';
import { LIVE_INDICATOR_COLOR, LIVE_INDICATOR_FOREGROUND_COLOR } from '@/styles/colors';
import { CreateRoomSheet } from '@/components/rooms/CreateRoomSheet';
import { SignInRequired } from '@/components/common/SignInRequired';

import {
  Button as LButton,
  Embed,
  HStack,
  Header,
  Icon,
  RawText,
  Text as LText,
  VStack,
  defineTokens,
  toElement,
  Group,
  ScrollView,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

const liveColors = defineTokens({
  color: { LIVE_INDICATOR_COLOR, LIVE_INDICATOR_FOREGROUND_COLOR },
});

const SectionHeader = ({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) =>
  toElement(
    HStack(
      VStack(Embed(icon)).margin('right', 'md'),
      VStack(
        LText(title).foreground('foreground').font('xl').leading('28px').weight('bold'),
        RawText(subtitle).font('sm').margin('top', '2xs').foreground('muted'),
      ).flex('1'),
    )
      .align('center')
      .margin('bottom', 'md'),
  );

const LiveRoomsScreen = screen(function LiveRoomsScreen() {
  const router = useRouter();
  const { canUsePrivateApi } = useAuth();
  const { t } = useTranslation();
  const { joinLiveRoom } = useLiveRoom();
  const [liveRooms, setLiveRooms] = useState<Room[]>([]);
  const [scheduledRooms, setScheduledRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadRooms = useCallback(async () => {
    if (!canUsePrivateApi) return;
    try {
      setLoading(true);
      setLoadFailed(false);
      const [live, scheduled] = await Promise.all([
        roomsService.getRooms('live'),
        roomsService.getRooms('scheduled'),
      ]);
      setLiveRooms(live);
      setScheduledRooms(scheduled);
    } catch (error) {
      logger.warn('Failed to load rooms', { error });
      setLoadFailed(true);
    } finally {
      setLoading(false);
      setHasFetched(true);
      setRefreshing(false);
    }
  }, [canUsePrivateApi]);

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadRooms();
  }, [loadRooms]);
  const openCreateSheet = useCallback(() => {
    void presentSheet((surface) => (
      <CreateRoomSheet
        onClose={() => surface.dismiss()}
        mode="standalone"
        onRoomCreated={loadRooms}
      />
    ));
  }, [loadRooms]);

  // Resolve all host IDs to user profiles
  const allHostIds = [...liveRooms, ...scheduledRooms].map((r) => r.host).filter(Boolean);
  useRoomUsers(allHostIds);

  const hasRooms = liveRooms.length > 0 || scheduledRooms.length > 0;
  const showSkeleton = loading && !hasFetched;
  // A failed refresh keeps the rooms already on screen; the error state only
  // takes over when there is nothing left to show.
  const showError = loadFailed && !hasRooms;

  const body = showSkeleton ? (
    <RoomsListSkeleton />
  ) : showError ? (
    <EmptyState
      sticker="offline"
      error={{
        title: t('agora.loadRoomsFailedTitle', { defaultValue: "Couldn't load rooms" }),
        message: t('agora.loadRoomsFailedMessage', {
          defaultValue: 'Check your connection and try again.',
        }),
        onRetry: loadRooms,
      }}
      containerStyle={{ paddingVertical: 48, paddingHorizontal: 20 }}
    />
  ) : !hasRooms ? (
    <EmptyState
      title="No rooms available"
      subtitle="Create a room to start a live audio conversation or schedule one for later"
      sticker="liveRooms"
      action={{
        label: t('agora.createRoom'),
        onPress: openCreateSheet,
      }}
      containerStyle={{ paddingVertical: 48, paddingHorizontal: 20 }}
    />
  ) : (
    <>
      {liveRooms.length > 0 &&
        toElement(
          VStack(
            Embed(
              <SectionHeader
                icon={toElement(
                  VStack(
                    Icon(RiBroadcastLine)
                      .size('18')
                      .foreground(liveColors.color.LIVE_INDICATOR_FOREGROUND_COLOR),
                  )
                    .frame({ width: '36', height: '36' })
                    .background(liveColors.color.LIVE_INDICATOR_COLOR)
                    .corner('infinite')
                    .align('center')
                    .justify('center'),
                )}
                title={t('agora.liveNow')}
                subtitle="Join the conversation"
              />,
            ),
            liveRooms.map((room) =>
              RoomCard({ room, onPress: () => joinLiveRoom(room._id) }).id(room._id),
            ),
          )
            .padding('horizontal', 'lg')
            .margin('top', 'lg'),
        )}

      {scheduledRooms.length > 0 &&
        toElement(
          VStack(
            Embed(
              <SectionHeader
                icon={toElement(
                  VStack(Icon(RiCalendarLine).size('18').foreground('onPrimary'))
                    .frame({ width: '36', height: '36' })
                    .background('primary')
                    .corner('infinite')
                    .align('center')
                    .justify('center'),
                )}
                title={t('agora.upcoming')}
                subtitle="Scheduled rooms"
              />,
            ),
            scheduledRooms.map((room) =>
              RoomCard({ room, onPress: () => router.push(`/live-rooms/${room._id}`) }).id(
                room._id,
              ),
            ),
          )
            .padding('horizontal', 'lg')
            .margin('top', 'lg'),
        )}
    </>
  );

  // The SEO tags draw nothing in place (the document's head on the web).
  return Group(
    Embed(<SEO title="Live Rooms" description="Join live audio conversations" />),
    Embed(
      <SignInRequired
        label={t('agora.signInRequired', { defaultValue: 'Sign in to join live rooms' })}
        description={t('agora.signInRequiredDesc', {
          defaultValue:
            'Live audio conversations, and the rooms you host, appear here once you sign in.',
        })}
      >
        {toElement(
          ScrollView(Embed(body))
            .refreshable({ refreshing, onRefresh }, { ios: 'primary' })
            .contentView((v) => v.padding('bottom', '2xl')),
        )}
      </SignInRequired>,
    ),
  )
    .onReselect(onRefresh)
    .header(
      Header(t('agora.title'))
        .toolbar(
          Embed(
            // Signed out, Syra refuses the create with a 401, and the sheet
            // gave no sign of it. The button is only offered to a reader who
            // can create; everyone else gets the sign-in prompt below.
            canUsePrivateApi
              ? toElement(
                  LButton(Icon(RiAddLine), LText('Create'))
                    .style('solid')
                    .tint('accent')
                    .onPress(openCreateSheet),
                )
              : undefined,
          ),
        )
        .inPage(),
    );
});

export default LiveRoomsScreen;
