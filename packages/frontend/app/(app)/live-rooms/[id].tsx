import React, { useEffect, useState, useCallback, useContext } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Share } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueries } from '@tanstack/react-query';
import { queryKeys } from '@oxy.so/services';
import type { User } from '@oxy.so/core';
import { useSafeBack } from '@/hooks/useSafeBack';
import { toast } from '@oxy.so/bloom/toast';
import { Avatar } from '@oxy.so/bloom/avatar';
import { AvatarGroup, type AvatarGroupItem } from '@oxy.so/bloom/avatar-group';
import { Button } from '@oxy.so/bloom/button';
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
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text as BloomText } from '@oxy.so/bloom/typography';
import { EmptyState } from '@/components/common/EmptyState';
import { SEO } from '@/components/SEO';

import { useTheme } from '@oxy.so/bloom/theme';
import { useRoomUsers, getDisplayName, getAvatarUrl } from '@/hooks/useRoomUsers';
import type { FileUrlResolver } from '@/utils/imageUrlCache';
import { useUserById } from '@/hooks/useCachedUser';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { roomsService, type Room } from '@/lib/syraApi';
import { FollowButton, useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { logger } from '@oxy.so/core/logger';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { confirmDialog } from '@/utils/alerts';
import { reportService } from '@/services/reportService';
import { ReportModal } from '@/components/report/ReportModal';
import { LIVE_INDICATOR_COLOR, LIVE_INDICATOR_FOREGROUND_COLOR } from '@/styles/colors';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { ProfileHoverCard } from '@/components/ProfileHoverCard';
import { profileHrefForUser } from '@/components/Profile/profileRoute';

/** The participant pile stays glanceable; the overflow collapses into Bloom's "+N" chip. */
const MAX_PARTICIPANT_AVATARS = 10;

/**
 * The faces for one of the room's avatar piles, read from the same user cache
 * `useRoomUsers` warms (same key, same fetch), for only the ids the pile shows.
 */
function useRoomAvatarItems(userIds: string[], oxyServices: FileUrlResolver & { getUserById: (id: string) => Promise<User> }): AvatarGroupItem[] {
  const results = useQueries({
    queries: userIds.map((userId) => ({
      queryKey: queryKeys.users.detail(userId),
      queryFn: () => oxyServices.getUserById(userId),
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
function openRoomMember(item: AvatarGroupItem) {
  const href = profileHrefForUser({ username: item.username });
  if (href) router.push(href);
}

/** The hover card's action — the same follow control the profile preview carries. */
function renderFollowAction(item: AvatarGroupItem) {
  return item.id ? <FollowButton userId={item.id} size="small" /> : null;
}

const HostInfo = ({ hostId, oxyServices }: { hostId: string; oxyServices: FileUrlResolver }) => {
  const profile = useUserById(hostId);
  const displayName = getDisplayName(profile, hostId);
  const avatarUri = getAvatarUrl(profile, oxyServices);

  return (
    <ProfileHoverCard username={getNormalizedUserHandle(profile) ?? undefined}>
      <View className="flex-row items-center">
        <Avatar size={48} source={avatarUri} shape="squircle" />
        <View className="flex-1 ml-3">
          <BloomText className="text-foreground text-base leading-6 font-semibold">{displayName}</BloomText>
          {profile?.username && (
            <Text className="text-sm mt-0.5 text-muted-foreground">@{profile.username}</Text>
          )}
        </View>
      </View>
    </ProfileHoverCard>
  );
};

const SectionHeading = ({ children }: { children: React.ReactNode }) => (
  <BloomText className="text-foreground text-base leading-6 font-semibold mb-3">
    {children}
  </BloomText>
);

const RoomDetailScreen = () => {
  const theme = useTheme();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, oxyServices } = useAuth();
  const safeBack = useSafeBack();
  const { joinLiveRoom } = useLiveRoom();
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [isJoined, setIsJoined] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const bottomSheet = useContext(BottomSheetContext);

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
      safeBack();
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
    try {
      await Share.share({
        message: `${room.title}\n\n${url}`,
        url,
        title: room.title,
      });
    } catch {
      // User cancelled or share failed silently
    }
  }, [room, id]);

  const handleMoreOptions = useCallback(() => {
    if (!room || !id) return;

    const handleShare = () => {
      bottomSheet.openBottomSheet(false);
      handleShareRoom();
    };

    const handleLeave = async () => {
      bottomSheet.openBottomSheet(false);
      const confirmed = await confirmDialog({
        title: t('agora.leaveRoomConfirmTitle', { defaultValue: 'Leave room' }),
        message: t('agora.leaveRoomConfirmMessage', { defaultValue: 'Are you sure you want to leave this room?' }),
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
        toast(t('agora.leaveRoomFailed', { defaultValue: 'Failed to leave room' }), { type: 'error' });
      }
      setActionLoading(false);
    };

    const handleReport = () => {
      bottomSheet.setBottomSheetContent(
        <ReportModal
          visible={true}
          onClose={() => bottomSheet.openBottomSheet(false)}
          onSubmit={async (categories, details) => {
            bottomSheet.openBottomSheet(false);
            const success = await reportService.reportRoom(id, categories, details);
            if (success) {
              toast(t('agora.reportThankYou', { defaultValue: 'Thank you for helping keep our community safe.' }), { type: 'success' });
            } else {
              toast(t('agora.reportFailed', { defaultValue: 'Failed to submit report.' }), { type: 'error' });
            }
          }}
        />
      );
      bottomSheet.openBottomSheet(true);
    };

    const MenuContent = () => (
      <View className="py-2">
        <Item
          role="menuitem"
          onPress={handleShare}
          leading={<RiShareForwardLine width={22} height={22} fill={theme.colors.text} />}
          title={t('agora.shareRoom', { defaultValue: 'Share room' })}
        />
        {isJoined && !isHost && (
          <Item
            role="menuitem"
            destructive
            onPress={handleLeave}
            leading={<RiLogoutBoxRLine width={22} height={22} fill={theme.colors.error} />}
            title={t('agora.leaveRoom', { defaultValue: 'Leave room' })}
          />
        )}
        {!isHost && (
          <Item
            role="menuitem"
            destructive
            onPress={handleReport}
            leading={<RiFlagLine width={22} height={22} fill={theme.colors.error} />}
            title={t('agora.reportRoom', { defaultValue: 'Report room' })}
          />
        )}
      </View>
    );

    bottomSheet.setBottomSheetContent(<MenuContent />);
    bottomSheet.openBottomSheet(true);
  }, [room, id, isJoined, isHost, theme, t, bottomSheet, handleShareRoom, loadRoom]);

  // Resolve user IDs to real profiles. Hooks must run on every render, so this
  // stays above the loading / error branches.
  const allUserIds = [room?.host, ...(room?.participants || []), ...(room?.speakers || [])].filter(
    (userId): userId is string => Boolean(userId)
  );
  useRoomUsers(allUserIds);

  const participants = room?.participants ?? [];
  const speakers = room?.speakers ?? [];
  const participantItems = useRoomAvatarItems(participants.slice(0, MAX_PARTICIPANT_AVATARS), oxyServices);
  const speakerItems = useRoomAvatarItems(speakers.slice(0, MAX_PARTICIPANT_AVATARS), oxyServices);

  return (
    <>
      <SEO
        title={room?.title ?? t('agora.room')}
        description={room?.description || 'Join this room'}
      />
      <View className="flex-1">
        <PageHeader
          title={room ? undefined : t('agora.room')}
          onBack={() => safeBack()}
          backLabel={t('common.back', { defaultValue: 'Back' })}
          actions={
            room ? (
              <Button
                appearance="subtle" tone="neutral"
                iconOnly
                leadingIcon={RiMoreFill}
                accessibilityLabel={t('common.options', { defaultValue: 'Options' })}
                onPress={handleMoreOptions}
              />
            ) : undefined
          }
        />

        {loading ? (
          <View className="flex-1 items-center justify-center">
            <Loading className="text-primary" />
          </View>
        ) : !room ? (
          <EmptyState
            icon={{ name: 'alert-circle-outline' }}
            error={{
              title: t('agora.roomUnavailableTitle', { defaultValue: "Couldn't load this room" }),
              message: t('agora.roomUnavailableMessage', {
                defaultValue: 'The room may have ended, or your connection dropped.',
              }),
              onRetry: loadRoom,
            }}
          />
        ) : (
          <>
            <ScrollView className="flex-1" contentContainerClassName="pb-28">
              {/* Status */}
              <View className="px-4 pt-2 items-start">
                {isLive && (
                  <View
                    className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full"
                    style={{ backgroundColor: LIVE_INDICATOR_COLOR }}
                  >
                    <View className="w-2 h-2 rounded-full bg-white" />
                    <Text className="text-xs font-bold text-white">LIVE</Text>
                  </View>
                )}
                {isScheduled && (
                  <View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted">
                    <RiCalendarLine width={14} height={14} fill={theme.colors.text} />
                    <Text className="text-xs font-bold text-foreground">SCHEDULED</Text>
                  </View>
                )}
                {isEnded && (
                  <View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted">
                    <Text className="text-xs font-bold text-muted-foreground">ENDED</Text>
                  </View>
                )}
              </View>

              {/* Title and description */}
              <View className="px-4 pt-4">
                <BloomText className="text-foreground text-xl font-bold mb-2">
                  {room.title}
                </BloomText>
                {room.topic && (
                  <Text className="text-base mb-2 text-muted-foreground">{room.topic}</Text>
                )}
                {room.description && (
                  <Text className="text-[15px] leading-[22px] mt-2 text-foreground">
                    {room.description}
                  </Text>
                )}
              </View>

              {/* Host */}
              <View className="px-4 mt-6">
                <SectionHeading>Host</SectionHeading>
                <HostInfo hostId={room.host} oxyServices={oxyServices} />
              </View>

              {/* Participants */}
              <View className="px-4 mt-6">
                <SectionHeading>Participants ({participants.length})</SectionHeading>
                {participantItems.length > 0 ? (
                  <AvatarGroup
                    items={participantItems}
                    size={32}
                    max={MAX_PARTICIPANT_AVATARS}
                    total={participants.length}
                    ringColor={theme.colors.background}
                    hoverCard
                    renderItemAction={renderFollowAction}
                    onPressItem={openRoomMember}
                  />
                ) : (
                  <Text className="text-sm text-muted-foreground">No participants yet</Text>
                )}
              </View>

              {/* Speakers */}
              {speakerItems.length > 0 && (
                <View className="px-4 mt-6">
                  <SectionHeading>Speakers</SectionHeading>
                  <AvatarGroup
                    items={speakerItems}
                    size={32}
                    max={MAX_PARTICIPANT_AVATARS}
                    total={speakers.length}
                    ringColor={theme.colors.background}
                    hoverCard
                    renderItemAction={renderFollowAction}
                    onPressItem={openRoomMember}
                  />
                </View>
              )}

              {/* Stats */}
              {room.stats && (
                <Card
                  variant="outlined"
                  radius="radius-12"
                  className="mx-4 mt-6 flex-row items-center p-4"
                >
                  <View className="flex-1 items-center">
                    <BloomText variant="title-1-semibold">
                      {room.stats.peakListeners || 0}
                    </BloomText>
                    <BloomText variant="body-2-regular" style={{ marginTop: 4, color: theme.colors.textSecondary }}>
                      Peak listeners
                    </BloomText>
                  </View>
                  <Divider vertical spacing={16} style={{ height: 40, alignSelf: 'center' }} />
                  <View className="flex-1 items-center">
                    <BloomText variant="title-1-semibold">
                      {room.stats.totalJoined || 0}
                    </BloomText>
                    <BloomText variant="body-2-regular" style={{ marginTop: 4, color: theme.colors.textSecondary }}>
                      Total joined
                    </BloomText>
                  </View>
                </Card>
              )}
            </ScrollView>

            {/* Actions — a live host gets Join + End side by side, hence the row. */}
            <View className="absolute bottom-0 left-0 right-0 flex-row gap-2 px-4 py-3 bg-card border-t border-border">
              {isLive && (
                <TouchableOpacity
                  className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-3xl bg-primary"
                  style={{ opacity: actionLoading ? 0.6 : 1 }}
                  onPress={() => joinLiveRoom(id)}
                  disabled={actionLoading}
                >
                  <RiBroadcastLine width={20} height={20} fill={theme.colors.primaryForeground} />
                  <Text className="text-base font-semibold text-primary-foreground">Join Live</Text>
                </TouchableOpacity>
              )}
              {isHost && isScheduled && (
                <TouchableOpacity
                  className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-3xl bg-primary"
                  style={{ opacity: actionLoading ? 0.6 : 1 }}
                  onPress={handleStartRoom}
                  disabled={actionLoading}
                >
                  <RiPlayFill width={20} height={20} fill={theme.colors.primaryForeground} />
                  <Text className="text-base font-semibold text-primary-foreground">Start Room</Text>
                </TouchableOpacity>
              )}
              {!isHost && isScheduled && (
                <View className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-3xl bg-muted">
                  <RiTimeLine width={20} height={20} fill={theme.colors.textSecondary} />
                  <Text className="text-base font-semibold text-muted-foreground">
                    Room not started yet
                  </Text>
                </View>
              )}
              {isHost && isLive && (
                <TouchableOpacity
                  className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-3xl"
                  style={{
                    backgroundColor: LIVE_INDICATOR_COLOR,
                    opacity: actionLoading ? 0.6 : 1,
                  }}
                  onPress={handleEndRoom}
                  disabled={actionLoading}
                >
                  <RiStopFill width={20} height={20} fill={LIVE_INDICATOR_FOREGROUND_COLOR} />
                  <Text className="text-base font-semibold text-white">End Room</Text>
                </TouchableOpacity>
              )}
              {isEnded && (
                <View className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-3xl bg-muted">
                  <RiCheckboxCircleLine width={20} height={20} fill={theme.colors.textSecondary} />
                  <Text className="text-base font-semibold text-muted-foreground">
                    This room has ended
                  </Text>
                </View>
              )}
            </View>
          </>
        )}
      </View>
    </>
  );
};

export default RoomDetailScreen;
