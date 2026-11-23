import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import { useEffect, useState, useCallback } from 'react';
import type { ViewStyle } from 'react-native';
import { useRouter, useLocalSearchParams } from '@/lib/navigation/router';
import { useQueries } from '@tanstack/react-query';
import { queryKeys } from '@oxy.so/services/ui/client';
import type { OxyServices, User } from '@oxy.so/core';
import { toast } from '@oxy.so/bloom/toast';
import { Avatar } from '@oxy.so/bloom/avatar';
import { AvatarGroup, type AvatarGroupItem } from '@oxy.so/bloom/avatar-group';
import { Card } from '@oxy.so/bloom/card';
import { Divider } from '@oxy.so/bloom/divider';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiCalendarLine } from '@oxy.so/bloom/icons/RiCalendarLine';
import { RiCheckboxCircleLine } from '@oxy.so/bloom/icons/RiCheckboxCircleLine';
import { RiFlagLine } from '@oxy.so/bloom/icons/RiFlagLine';
import { RiLogoutBoxRLine } from '@oxy.so/bloom/icons/RiLogoutBoxRLine';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { RiPlayFill } from '@oxy.so/bloom/icons/RiPlayFill';
import { RiShareForwardLine } from '@oxy.so/bloom/icons/RiShareForwardLine';
import { RiStopFill } from '@oxy.so/bloom/icons/RiStopFill';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { PageFooter } from '@oxy.so/bloom/page-footer';
import { Screen, useScreenBack } from '@oxy.so/bloom/screen';
import { EmptyState } from '@/components/common/EmptyState';
import { SEO } from '@/components/SEO';

import { useTheme } from '@oxy.so/bloom/theme';
import { useRoomUsers, getDisplayName, getAvatarUrl } from '@/hooks/useRoomUsers';
import { useUserById } from '@/hooks/useCachedUser';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { roomsService, type Room } from '@/lib/syraApi';
import { useAuth } from '@oxy.so/services/ui/client';
import { FollowButton } from '@/components/FollowButton';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import { presentSheet } from '@/utils/sheet';
import { shareLink } from '@/utils/shareLink';
import { confirmDialog } from '@/utils/alerts';
import { reportService } from '@/services/reportService';
import { ReportModal } from '@/components/report/ReportModal';
import { LIVE_INDICATOR_COLOR } from '@/styles/colors';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { ProfileHoverCard } from '@/components/ProfileHoverCard';
import { profileHrefForUser } from '@/components/Profile/profileRoute';

import {
  Button as LButton,
  Embed,
  HStack,
  Header,
  Icon,
  Item,
  Menu,
  RawText,
  ScrollView,
  Text as LText,
  type TextRun,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';

const liveColors = defineTokens({ color: { LIVE_INDICATOR_COLOR } });

// The stats card lays its two figures out in a row: Bloom's Card takes no axis in the
// language, so it stays a Card element with that layout as its style.
const statsCardStyle: ViewStyle = {
  marginHorizontal: 16,
  marginTop: 24,
  flexDirection: 'row',
  alignItems: 'center',
  padding: 16,
};

/** The participant pile stays glanceable; the overflow collapses into Bloom's "+N" chip. */
const MAX_PARTICIPANT_AVATARS = 10;

/**
 * The faces for one of the room's avatar piles, read from the same user cache
 * `useRoomUsers` warms (same key, same fetch), for only the ids the pile shows.
 */
function useRoomAvatarItems(
  userIds: string[],
  oxyServices: Pick<OxyServices, 'assets' | 'users'>,
): AvatarGroupItem[] {
  const results = useQueries({
    queries: userIds.map((userId) => ({
      queryKey: queryKeys.users.detail(userId),
      queryFn: () => oxyServices.users.get(userId),
      staleTime: 5 * 60 * 1000,
    })),
  });
  return userIds.map((userId, index) => {
    const profile = results[index]?.data as User | undefined;
    return {
      id: userId,
      uri: getAvatarUrl(profile, oxyServices),
      displayName: getDisplayName(profile, userId),
      username: profile?.username,
    };
  });
}

/** A face in a pile opens that person's profile (and, on web, its hover card links there too). */
function openRoomMember(router: ReturnType<typeof useRouter>, item: AvatarGroupItem) {
  const href = profileHrefForUser({ username: item.username });
  if (href) router.push(href);
}

/** The hover card's action — the same follow control the profile preview carries. */
function renderFollowAction(item: AvatarGroupItem) {
  return item.id ? <FollowButton userId={item.id} size="sm" /> : null;
}

const HostInfo = ({
  hostId,
  oxyServices,
}: {
  hostId: string;
  oxyServices: Pick<OxyServices, 'assets'>;
}) => {
  const profile = useUserById(hostId);
  const displayName = getDisplayName(profile, hostId);
  const avatarUri = getAvatarUrl(profile, oxyServices);

  return (
    <ProfileHoverCard username={getNormalizedUserHandle(profile) ?? undefined}>
      {toElement(
        HStack(
          Embed(<Avatar size={48} source={avatarUri} shape="squircle" />),
          VStack(
            LText(displayName)
              .foreground('foreground')
              .font('16')
              .leading('24px')
              .weight('semibold'),
            Embed(
              profile?.username &&
                toElement(
                  RawText('@', profile.username)
                    .font('14')
                    .leading('20px')
                    .margin('top', '2xs')
                    .foreground('muted'),
                ),
            ),
          )
            .flex('1')
            .margin('left', 'md'),
        ).align('center'),
      )}
    </ProfileHoverCard>
  );
};

const sectionHeading = (...runs: TextRun[]) =>
  LText(...runs)
    .foreground('foreground')
    .font('16')
    .leading('24px')
    .weight('semibold')
    .margin('bottom', 'md');

const RoomDetailScreen = () => {
  const router = useRouter();
  const theme = useTheme();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, oxyServices } = useAuth();
  const back = useScreenBack();
  const { joinLiveRoom } = useLiveRoom();
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [isJoined, setIsJoined] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const loadRoom = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      const data = await roomsService.getRoom(id);
      setRoom(data);
      if (data && user?.id) {
        setIsJoined(data.participants?.includes(user.id) ?? false);
      }
    } catch (error) {
      logger.warn('Failed to load room', { error });
      setRoom(null);
    } finally {
      setLoading(false);
    }
  }, [id, user?.id]);

  useEffect(() => {
    loadRoom();
  }, [loadRoom]);

  const handleStartRoom = async () => {
    if (!id || !room) return;
    setActionLoading(true);
    const success = await roomsService.startRoom(id);
    if (success) {
      joinLiveRoom(id);
    } else {
      toast('Failed to start room', { type: 'error' });
    }
    setActionLoading(false);
  };

  const handleEndRoom = async () => {
    if (!id || !room) return;
    setActionLoading(true);
    const success = await roomsService.endRoom(id);
    if (success) {
      back?.();
    } else {
      toast('Failed to end room', { type: 'error' });
    }
    setActionLoading(false);
  };

  const isLive = room?.status === 'live';
  const isScheduled = room?.status === 'scheduled';
  const isEnded = room?.status === 'ended';
  const isHost = room?.host === user?.id;

  const handleShareRoom = useCallback(async () => {
    if (!room) return;
    const url = `https://mention.earth/live-rooms/${id}`;
    await shareLink({
      title: room.title,
      url,
      copiedToast: t('widgetMenu.linkCopied'),
      errorToast: t('widgetMenu.shareFailed'),
    });
  }, [room, id, t]);

  const handleLeave = async () => {
    if (!id) return;
    const confirmed = await confirmDialog({
      title: t('agora.leaveRoomConfirmTitle', { defaultValue: 'Leave room' }),
      message: t('agora.leaveRoomConfirmMessage', {
        defaultValue: 'Are you sure you want to leave this room?',
      }),
      okText: t('agora.leaveRoom', { defaultValue: 'Leave room' }),
      cancelText: t('common.cancel', { defaultValue: 'Cancel' }),
      destructive: true,
    });
    if (!confirmed) return;
    setActionLoading(true);
    const success = await roomsService.leaveRoom(id);
    if (success) {
      setIsJoined(false);
      loadRoom();
      toast(t('agora.leftRoom', { defaultValue: 'You have left the room' }), { type: 'success' });
    } else {
      toast(t('agora.leaveRoomFailed', { defaultValue: 'Failed to leave room' }), {
        type: 'error',
      });
    }
    setActionLoading(false);
  };

  const handleReport = () => {
    if (!id) return;
    void presentSheet((surface) => (
      <ReportModal
        visible={true}
        onClose={() => surface.dismiss()}
        onSubmit={async (categories, details) => {
          surface.dismiss();
          const success = await reportService.reportRoom(id, categories, details);
          if (success) {
            toast(
              t('agora.reportThankYou', {
                defaultValue: 'Thank you for helping keep our community safe.',
              }),
              { type: 'success' },
            );
          } else {
            toast(t('agora.reportFailed', { defaultValue: 'Failed to submit report.' }), {
              type: 'error',
            });
          }
        }}
      />
    ));
  };

  // Resolve user IDs to real profiles. Hooks must run on every render, so this
  // stays above the loading / error branches.
  const allUserIds = [room?.host, ...(room?.participants || []), ...(room?.speakers || [])].filter(
    (userId): userId is string => Boolean(userId),
  );
  useRoomUsers(allUserIds);

  const participants = room?.participants ?? [];
  const speakers = room?.speakers ?? [];
  const participantItems = useRoomAvatarItems(
    participants.slice(0, MAX_PARTICIPANT_AVATARS),
    oxyServices,
  );
  const speakerItems = useRoomAvatarItems(speakers.slice(0, MAX_PARTICIPANT_AVATARS), oxyServices);

  return (
    <>
      <SEO
        title={room?.title ?? t('agora.room')}
        description={room?.description || 'Join this room'}
      />
      <Screen
        header={toElement(
          Header(room ? undefined : t('agora.room'))
            .backLabel(t('common.back', { defaultValue: 'Back' }))
            .toolbar(
              room
                ? Menu(
                    LButton(Icon(RiMoreFill))
                      .shape('circle')
                      .style('subtle')
                      .tint('neutral')
                      .label(t('common.options', { defaultValue: 'Options' })),
                    Item(t('agora.shareRoom', { defaultValue: 'Share room' }))
                      .icon(RiShareForwardLine)
                      .iconSize('22')
                      .iconForeground('foreground')
                      .onPress(handleShareRoom),
                    isJoined && !isHost
                      ? Item(t('agora.leaveRoom', { defaultValue: 'Leave room' }))
                          .icon(RiLogoutBoxRLine)
                          .iconSize('22')
                          .iconForeground('error')
                          .destructive()
                          .onPress(handleLeave)
                      : null,
                    isHost
                      ? null
                      : Item(t('agora.reportRoom', { defaultValue: 'Report room' }))
                          .icon(RiFlagLine)
                          .iconSize('22')
                          .iconForeground('error')
                          .destructive()
                          .onPress(handleReport),
                  ).label(t('common.options', { defaultValue: 'Options' }))
                : null,
            )
            .inPage(),
        )}
        bottomBar={
          // Actions — a live host gets Join + End side by side, hence the row.
          !loading && room ? (
            <PageFooter>
              {toElement(
                HStack(
                  isLive
                    ? LButton(Icon(RiBroadcastLine), LText('Join Live'))
                        .flex('1')
                        .onPress(() => joinLiveRoom(id))
                        .disabled(actionLoading)
                    : null,
                  isHost && isScheduled
                    ? LButton(Icon(RiPlayFill), LText('Start Room'))
                        .flex('1')
                        .onPress(handleStartRoom)
                        .loading(actionLoading)
                    : null,
                  !isHost && isScheduled
                    ? LButton(Icon(RiTimeLine), LText('Room not started yet'))
                        .style('subtle')
                        .tint('neutral')
                        .flex('1')
                        .disabled()
                    : null,
                  isHost && isLive
                    ? LButton(Icon(RiStopFill), LText('End Room'))
                        .tint('danger')
                        .flex('1')
                        .onPress(handleEndRoom)
                        .loading(actionLoading)
                    : null,
                  isEnded
                    ? LButton(Icon(RiCheckboxCircleLine), LText('This room has ended'))
                        .style('subtle')
                        .tint('neutral')
                        .flex('1')
                        .disabled()
                    : null,
                ).spacing('sm'),
              )}
            </PageFooter>
          ) : undefined
        }
      >
        {toElement(
          ScrollView(
            Embed(
              loading ? (
                <DetailSkeleton />
              ) : !room ? (
                <EmptyState
                  error={{
                    title: t('agora.roomUnavailableTitle', {
                      defaultValue: "Couldn't load this room",
                    }),
                    message: t('agora.roomUnavailableMessage', {
                      defaultValue: 'The room may have ended, or your connection dropped.',
                    }),
                    onRetry: loadRoom,
                  }}
                />
              ) : (
                <>
                  {/* Status */}
                  {toElement(
                    VStack(
                      isLive
                        ? HStack(
                            VStack()
                              .frame({ width: 'sm', height: 'sm' })
                              .background('white')
                              .corner('infinite'),
                            RawText('LIVE')
                              .font('xs')
                              .leading('16px')
                              .weight('bold')
                              .foreground('white'),
                          )
                            .padding('horizontal', 'md')
                            .padding('vertical', '6')
                            .background(liveColors.color.LIVE_INDICATOR_COLOR)
                            .corner('infinite')
                            .align('center')
                            .spacing('6')
                        : null,
                      Embed(
                        isScheduled &&
                          toElement(
                            HStack(
                              Icon(RiCalendarLine).size('14').foreground('foreground'),
                              RawText('SCHEDULED')
                                .font('xs')
                                .leading('16px')
                                .weight('bold')
                                .foreground('foreground'),
                            )
                              .padding('horizontal', 'md')
                              .padding('vertical', '6')
                              .background('mutedFill')
                              .corner('infinite')
                              .align('center')
                              .spacing('6'),
                          ),
                      ),
                      Embed(
                        isEnded &&
                          toElement(
                            HStack(
                              RawText('ENDED')
                                .font('xs')
                                .leading('16px')
                                .weight('bold')
                                .foreground('muted'),
                            )
                              .padding('horizontal', 'md')
                              .padding('vertical', '6')
                              .background('mutedFill')
                              .corner('infinite')
                              .align('center')
                              .spacing('6'),
                          ),
                      ),
                    )
                      .padding('horizontal', 'lg')
                      .padding('top', 'sm')
                      .align('start'),
                  )}

                  {/* Title and description */}
                  {toElement(
                    VStack(
                      LText(room.title)
                        .foreground('foreground')
                        .font('xl')
                        .leading('28px')
                        .weight('bold')
                        .margin('bottom', 'sm'),
                      Embed(
                        room.topic &&
                          toElement(
                            RawText(room.topic)
                              .font('16')
                              .leading('normal')
                              .margin('bottom', 'sm')
                              .foreground('muted'),
                          ),
                      ),
                      Embed(
                        room.description &&
                          toElement(
                            RawText(room.description)
                              .font('md')
                              .leading('22px')
                              .margin('top', 'sm')
                              .foreground('foreground'),
                          ),
                      ),
                    )
                      .padding('horizontal', 'lg')
                      .padding('top', 'lg'),
                  )}

                  {/* Host */}
                  {toElement(
                    VStack(
                      sectionHeading('Host'),
                      Embed(<HostInfo hostId={room.host} oxyServices={oxyServices} />),
                    )
                      .padding('horizontal', 'lg')
                      .margin('top', '2xl'),
                  )}

                  {/* Participants */}
                  {toElement(
                    VStack(
                      sectionHeading('Participants (', participants.length, ')'),
                      Embed(
                        participantItems.length > 0 ? (
                          <AvatarGroup
                            items={participantItems}
                            size={32}
                            max={MAX_PARTICIPANT_AVATARS}
                            total={participants.length}
                            ringColor={theme.colors.background}
                            hoverCard
                            renderItemAction={renderFollowAction}
                            onPressItem={(item) => openRoomMember(router, item)}
                          />
                        ) : (
                          toElement(
                            RawText('No participants yet')
                              .font('14')
                              .leading('20px')
                              .foreground('muted'),
                          )
                        ),
                      ),
                    )
                      .padding('horizontal', 'lg')
                      .margin('top', '2xl'),
                  )}

                  {/* Speakers */}
                  {speakerItems.length > 0 &&
                    toElement(
                      VStack(
                        sectionHeading('Speakers'),
                        Embed(
                          <AvatarGroup
                            items={speakerItems}
                            size={32}
                            max={MAX_PARTICIPANT_AVATARS}
                            total={speakers.length}
                            ringColor={theme.colors.background}
                            hoverCard
                            renderItemAction={renderFollowAction}
                            onPressItem={(item) => openRoomMember(router, item)}
                          />,
                        ),
                      )
                        .padding('horizontal', 'lg')
                        .margin('top', '2xl'),
                    )}

                  {/* Stats */}
                  {room.stats && (
                    <Card radius="radius-12" style={statsCardStyle} appearance="outline">
                      {toElement(
                        VStack(
                          LText(room.stats.peakListeners || 0)
                            .font('title-1')
                            .weight('semibold'),
                          LText('Peak listeners')
                            .margin('top', 'xs')
                            .foreground('muted')
                            .font('body-2'),
                        )
                          .flex('1')
                          .align('center'),
                      )}
                      <Divider vertical spacing={16} style={{ height: 40, alignSelf: 'center' }} />
                      {toElement(
                        VStack(
                          LText(room.stats.totalJoined || 0)
                            .font('title-1')
                            .weight('semibold'),
                          LText('Total joined')
                            .margin('top', 'xs')
                            .foreground('muted')
                            .font('body-2'),
                        )
                          .flex('1')
                          .align('center'),
                      )}
                    </Card>
                  )}
                </>
              ),
            ),
          ),
        )}
      </Screen>
    </>
  );
};

export default RoomDetailScreen;
