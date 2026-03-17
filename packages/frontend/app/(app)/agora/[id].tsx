import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Ionicons } from '@expo/vector-icons';
import { toast } from 'sonner';

import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Loading } from '@oxyhq/bloom/loading';
import SEO from '@/components/SEO';

import { useTheme } from '@oxyhq/bloom/theme';
import { useRoomUsers, getDisplayName, getAvatarUrl } from '@/hooks/useRoomUsers';
import { useUserById } from '@/stores/usersStore';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { roomsService, type Room } from '@/services/roomsService';
import { useAuth } from '@oxyhq/services';

// Wrapper to use useUserById hook for each participant
const ParticipantAvatar = ({ userId, oxyServices }: { userId: string; oxyServices: any }) => {
  const profile = useUserById(userId);
  const avatarUri = getAvatarUrl(profile, oxyServices);
  const displayName = getDisplayName(profile, userId);
  return <Avatar size={32} source={avatarUri} shape="squircle" />;
};

// Host info with resolved profile
const HostInfo = ({ hostId, oxyServices, theme }: { hostId: string; oxyServices: any; theme: any }) => {
  const profile = useUserById(hostId);
  const displayName = getDisplayName(profile, hostId);
  const avatarUri = getAvatarUrl(profile, oxyServices);

  return (
    <View className="flex-row items-center">
      <Avatar size={48} source={avatarUri} shape="squircle" />
      <View className="flex-1 ml-3">
        <ThemedText type="defaultSemiBold">{displayName}</ThemedText>
        {profile?.username && (
          <Text className="text-sm mt-0.5 text-muted-foreground">
            @{profile.username}
          </Text>
        )}
      </View>
    </View>
  );
};

const RoomDetailScreen = () => {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, oxyServices } = useAuth();
  const safeBack = useSafeBack();
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
      console.warn('Failed to load room', error);
    } finally {
      setLoading(false);
    }
  }, [id]);

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
      toast.error('Failed to start room');
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
      toast.error('Failed to end room');
    }
    setActionLoading(false);
  };

  const handleJoinRoom = async () => {
    if (!id || !room) return;
    joinLiveRoom(id);
  };

  const handleLeaveRoom = async () => {
    if (!id || !room) return;
    setActionLoading(true);
    const success = await roomsService.leaveRoom(id);
    if (success) {
      setIsJoined(false);
      loadRoom();
    } else {
      toast.error('Failed to leave room');
    }
    setActionLoading(false);
  };

  // Resolve user IDs to real profiles (must be before conditional return for hooks rules)
  const allUserIds = [room?.host, ...(room?.participants || []), ...(room?.speakers || [])].filter(Boolean);
  useRoomUsers(allUserIds);

  const isLive = room?.status === 'live';
  const isScheduled = room?.status === 'scheduled';
  const isEnded = room?.status === 'ended';
  const isHost = room?.host === user?.id;

  if (loading || !room) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <Header
          options={{
            title: 'Room',
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
        />
        <View className="flex-1 items-center justify-center">
          <Loading />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <>
      <SEO title={room.title} description={room.description || 'Join this room'} />
      <SafeAreaView className="flex-1 bg-background">
        <Header
          options={{
            title: '',
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
            rightComponents: [
              <IconButton variant="icon" key="more" onPress={() => {}}>
                <Ionicons name="ellipsis-horizontal" size={24} color={theme.colors.text} />
              </IconButton>,
            ],
          }}
          hideBottomBorder={false}
        />

        <ScrollView className="flex-1" contentContainerStyle={styles.scrollContent}>
          {/* Status Badge */}
          <View className="px-4 pt-2 items-start">
            {isLive && (
              <View style={styles.statusBadge} className="bg-[#FF4458]">
                <View className="w-2 h-2 rounded-full bg-white" />
                <Text className="text-xs font-bold text-white">LIVE</Text>
              </View>
            )}
            {isScheduled && (
              <View style={styles.statusBadge} className="bg-secondary">
                <Ionicons name="calendar-outline" size={14} color={theme.colors.text} />
                <Text className="text-xs font-bold text-foreground">SCHEDULED</Text>
              </View>
            )}
            {isEnded && (
              <View style={styles.statusBadge} className="bg-secondary">
                <Text className="text-xs font-bold text-muted-foreground">ENDED</Text>
              </View>
            )}
          </View>

          {/* Title and Description */}
          <View className="px-4 pt-4">
            <ThemedText type="title" style={styles.title}>
              {room.title}
            </ThemedText>
            {room.topic && (
              <Text className="text-base mb-2 text-muted-foreground">
                {room.topic}
              </Text>
            )}
            {room.description && (
              <Text className="text-[15px] leading-[22px] mt-2 text-foreground">
                {room.description}
              </Text>
            )}
          </View>

          {/* Host Info */}
          <View className="px-4 mt-6">
            <ThemedText type="defaultSemiBold" className="text-base mb-3">
              Host
            </ThemedText>
            <View className="flex-row items-center">
              <HostInfo hostId={room.host} oxyServices={oxyServices} theme={theme} />
            </View>
          </View>

          {/* Participants */}
          <View className="px-4 mt-6">
            <ThemedText type="defaultSemiBold" className="text-base mb-3">
              Participants ({room.participants?.length || 0})
            </ThemedText>
            <View className="flex-row flex-wrap gap-2">
              {room.participants?.length > 0 ? (
                room.participants.slice(0, 10).map((participantId) => (
                  <View key={participantId} className="mb-2">
                    <ParticipantAvatar userId={participantId} oxyServices={oxyServices} />
                  </View>
                ))
              ) : (
                <Text className="text-sm text-muted-foreground">
                  No participants yet
                </Text>
              )}
            </View>
          </View>

          {/* Speakers */}
          {room.speakers && room.speakers.length > 0 && (
            <View className="px-4 mt-6">
              <ThemedText type="defaultSemiBold" className="text-base mb-3">
                Speakers
              </ThemedText>
              <View className="flex-row flex-wrap gap-2">
                {room.speakers.map((speakerId) => (
                  <View key={speakerId} className="mb-2">
                    <ParticipantAvatar userId={speakerId} oxyServices={oxyServices} />
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Stats */}
          {room.stats && (
            <View style={[styles.statsCard, { borderColor: theme.colors.border }]} className="bg-card">
              <View className="flex-1 items-center">
                <ThemedText type="defaultSemiBold" className="text-2xl">
                  {room.stats.peakListeners || 0}
                </ThemedText>
                <Text className="text-[13px] mt-1 text-muted-foreground">
                  Peak listeners
                </Text>
              </View>
              <View style={{ width: 1, height: 40, marginHorizontal: 16, backgroundColor: theme.colors.border }} />
              <View className="flex-1 items-center">
                <ThemedText type="defaultSemiBold" className="text-2xl">
                  {room.stats.totalJoined || 0}
                </ThemedText>
                <Text className="text-[13px] mt-1 text-muted-foreground">
                  Total joined
                </Text>
              </View>
            </View>
          )}
        </ScrollView>

        {/* Action Buttons */}
        <View style={styles.actionBar} className="bg-background border-t border-border">
          {isLive && (
            <TouchableOpacity
              style={styles.primaryButton}
              className="bg-primary"
              onPress={() => joinLiveRoom(id)}
              disabled={actionLoading}
            >
              <Ionicons name="radio" size={20} color={theme.colors.card} />
              <Text className="text-base font-semibold" style={{ color: theme.colors.card }}>
                Join Live
              </Text>
            </TouchableOpacity>
          )}
          {isHost && isScheduled && (
            <TouchableOpacity
              style={styles.primaryButton}
              className="bg-primary"
              onPress={handleStartRoom}
              disabled={actionLoading}
            >
              <Ionicons name="play" size={20} color={theme.colors.card} />
              <Text className="text-base font-semibold" style={{ color: theme.colors.card }}>
                Start Room
              </Text>
            </TouchableOpacity>
          )}
          {!isHost && isScheduled && (
            <View style={styles.primaryButton} className="bg-secondary">
              <Ionicons name="time-outline" size={20} color={theme.colors.textSecondary} />
              <Text className="text-base font-semibold text-muted-foreground">
                Room not started yet
              </Text>
            </View>
          )}
          {isHost && isLive && (
            <TouchableOpacity
              style={styles.primaryButton}
              className="bg-[#FF4458]"
              onPress={handleEndRoom}
              disabled={actionLoading}
            >
              <Ionicons name="stop" size={20} color="#FFFFFF" />
              <Text className="text-base font-semibold text-white">End Room</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    </>
  );
};

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 100,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
  },
  title: {
    fontSize: 28,
    marginBottom: 8,
  },
  statsCard: {
    marginHorizontal: 16,
    marginTop: 24,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 24,
    gap: 8,
  },
});

export default RoomDetailScreen;
