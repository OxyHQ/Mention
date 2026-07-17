import React, { useEffect, useState, useCallback, useContext } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Share } from 'react-native';
import { SafeAreaView } from '@/lib/SafeAreaViewInterop';
import { useLocalSearchParams } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Ionicons } from '@expo/vector-icons';
import { show as toast } from '@oxyhq/bloom/toast';

import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Loading } from '@oxyhq/bloom/loading';
import { EmptyState } from '@/components/common/EmptyState';
import SEO from '@/components/SEO';

import { useTheme } from '@oxyhq/bloom/theme';
import { useRoomUsers, getDisplayName, getAvatarUrl } from '@/hooks/useRoomUsers';
import { useUserById } from '@/hooks/useCachedUser';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { roomsService } from '@/lib/liveConfig';
import type { Room } from '@syra.fm/sdk';
import { useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';
import { logger } from '@/lib/logger';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { confirmDialog } from '@/utils/alerts';
import { reportService } from '@/services/reportService';
import { ReportModal } from '@/components/report/ReportModal';
import { LIVE_INDICATOR_COLOR, LIVE_INDICATOR_FOREGROUND_COLOR } from '@/styles/colors';

/** The participant grid stays glanceable; the overflow collapses into a "+N" chip. */
const MAX_PARTICIPANT_AVATARS = 10;

const ParticipantAvatar = ({ userId, oxyServices }: { userId: string; oxyServices: unknown }) => {
  const profile = useUserById(userId);
  const avatarUri = getAvatarUrl(profile, oxyServices);
  return <Avatar size={32} source={avatarUri} shape="squircle" />;
};

const HostInfo = ({ hostId, oxyServices }: { hostId: string; oxyServices: unknown }) => {
  const profile = useUserById(hostId);
  const displayName = getDisplayName(profile, hostId);
  const avatarUri = getAvatarUrl(profile, oxyServices);

  return (
    <View className="flex-row items-center">
      <Avatar size={48} source={avatarUri} shape="squircle" />
      <View className="flex-1 ml-3">
        <ThemedText type="defaultSemiBold">{displayName}</ThemedText>
        {profile?.username && (
          <Text className="text-sm mt-0.5 text-muted-foreground">@{profile.username}</Text>
        )}
      </View>
    </View>
  );
};

const SectionHeading = ({ children }: { children: React.ReactNode }) => (
  <ThemedText type="defaultSemiBold" className="mb-3">
    {children}
  </ThemedText>
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
      <View className="py-2 px-4">
        <IconButton variant="icon" onPress={handleShare} className="w-full py-3.5">
          <View className="flex-row items-center w-full gap-3.5">
            <Ionicons name="share-outline" size={22} color={theme.colors.text} />
            <Text className="text-foreground text-base font-medium">
              {t('agora.shareRoom', { defaultValue: 'Share room' })}
            </Text>
          </View>
        </IconButton>
        {isJoined && !isHost && (
          <IconButton variant="icon" onPress={handleLeave} className="w-full py-3.5">
            <View className="flex-row items-center w-full gap-3.5">
              <Ionicons name="exit-outline" size={22} color={theme.colors.error} />
              <Text className="text-destructive text-base font-medium">
                {t('agora.leaveRoom', { defaultValue: 'Leave room' })}
              </Text>
            </View>
          </IconButton>
        )}
        {!isHost && (
          <IconButton variant="icon" onPress={handleReport} className="w-full py-3.5">
            <View className="flex-row items-center w-full gap-3.5">
              <Ionicons name="flag-outline" size={22} color={theme.colors.error} />
              <Text className="text-destructive text-base font-medium">
                {t('agora.reportRoom', { defaultValue: 'Report room' })}
              </Text>
            </View>
          </IconButton>
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
  const visibleParticipants = participants.slice(0, MAX_PARTICIPANT_AVATARS);
  const hiddenParticipantCount = participants.length - visibleParticipants.length;

  return (
    <>
      <SEO
        title={room?.title ?? t('agora.room')}
        description={room?.description || 'Join this room'}
      />
      <SafeAreaView className="flex-1 bg-background" edges={['top']}>
        <Header
          options={{
            title: room ? '' : t('agora.room'),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
            rightComponents: room
              ? [
                  <IconButton variant="icon" key="more" onPress={handleMoreOptions}>
                    <Ionicons name="ellipsis-horizontal" size={24} color={theme.colors.text} />
                  </IconButton>,
                ]
              : undefined,
          }}
          hideBottomBorder={false}
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
                  <View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary">
                    <Ionicons name="calendar-outline" size={14} color={theme.colors.text} />
                    <Text className="text-xs font-bold text-foreground">SCHEDULED</Text>
                  </View>
                )}
                {isEnded && (
                  <View className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary">
                    <Text className="text-xs font-bold text-muted-foreground">ENDED</Text>
                  </View>
                )}
              </View>

              {/* Title and description */}
              <View className="px-4 pt-4">
                <ThemedText type="subtitle" className="mb-2">
                  {room.title}
                </ThemedText>
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
                {visibleParticipants.length > 0 ? (
                  <View className="flex-row flex-wrap items-center gap-2">
                    {visibleParticipants.map((participantId) => (
                      <ParticipantAvatar
                        key={participantId}
                        userId={participantId}
                        oxyServices={oxyServices}
                      />
                    ))}
                    {hiddenParticipantCount > 0 && (
                      <View className="h-8 px-2 items-center justify-center rounded-lg bg-secondary">
                        <Text className="text-xs font-semibold text-muted-foreground">
                          +{hiddenParticipantCount}
                        </Text>
                      </View>
                    )}
                  </View>
                ) : (
                  <Text className="text-sm text-muted-foreground">No participants yet</Text>
                )}
              </View>

              {/* Speakers */}
              {room.speakers && room.speakers.length > 0 && (
                <View className="px-4 mt-6">
                  <SectionHeading>Speakers</SectionHeading>
                  <View className="flex-row flex-wrap items-center gap-2">
                    {room.speakers.map((speakerId) => (
                      <ParticipantAvatar
                        key={speakerId}
                        userId={speakerId}
                        oxyServices={oxyServices}
                      />
                    ))}
                  </View>
                </View>
              )}

              {/* Stats */}
              {room.stats && (
                <View className="mx-4 mt-6 flex-row items-center rounded-xl border border-border bg-card p-4">
                  <View className="flex-1 items-center">
                    <ThemedText type="defaultSemiBold" className="text-2xl">
                      {room.stats.peakListeners || 0}
                    </ThemedText>
                    <Text className="text-[13px] mt-1 text-muted-foreground">Peak listeners</Text>
                  </View>
                  <View className="w-px h-10 mx-4 bg-border" />
                  <View className="flex-1 items-center">
                    <ThemedText type="defaultSemiBold" className="text-2xl">
                      {room.stats.totalJoined || 0}
                    </ThemedText>
                    <Text className="text-[13px] mt-1 text-muted-foreground">Total joined</Text>
                  </View>
                </View>
              )}
            </ScrollView>

            {/* Actions — a live host gets Join + End side by side, hence the row. */}
            <View className="absolute bottom-0 left-0 right-0 flex-row gap-2 px-4 py-3 bg-background border-t border-border">
              {isLive && (
                <TouchableOpacity
                  className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-3xl bg-primary"
                  style={{ opacity: actionLoading ? 0.6 : 1 }}
                  onPress={() => joinLiveRoom(id)}
                  disabled={actionLoading}
                >
                  <Ionicons name="radio" size={20} color={theme.colors.primaryForeground} />
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
                  <Ionicons name="play" size={20} color={theme.colors.primaryForeground} />
                  <Text className="text-base font-semibold text-primary-foreground">Start Room</Text>
                </TouchableOpacity>
              )}
              {!isHost && isScheduled && (
                <View className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-3xl bg-secondary">
                  <Ionicons name="time-outline" size={20} color={theme.colors.textSecondary} />
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
                  <Ionicons name="stop" size={20} color={LIVE_INDICATOR_FOREGROUND_COLOR} />
                  <Text className="text-base font-semibold text-white">End Room</Text>
                </TouchableOpacity>
              )}
              {isEnded && (
                <View className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-3xl bg-secondary">
                  <Ionicons name="checkmark-done" size={20} color={theme.colors.textSecondary} />
                  <Text className="text-base font-semibold text-muted-foreground">
                    This room has ended
                  </Text>
                </View>
              )}
            </View>
          </>
        )}
      </SafeAreaView>
    </>
  );
};

export default RoomDetailScreen;
