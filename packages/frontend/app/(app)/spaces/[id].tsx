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
import { Ionicons } from '@expo/vector-icons';
import { toast } from 'sonner';

import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import Avatar from '@/components/Avatar';
import { Loading } from '@/components/ui/Loading';
import SEO from '@/components/SEO';

import { useTheme } from '@/hooks/useTheme';
import { useSpaceUsers, getDisplayName, getAvatarUrl } from '@/hooks/useSpaceUsers';
import { useUserById } from '@/stores/usersStore';
import { useLiveSpace } from '@/context/LiveSpaceContext';
import { spacesService, type Space } from '@/services/spacesService';
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
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Avatar size={48} source={avatarUri} shape="squircle" />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <ThemedText type="defaultSemiBold">{displayName}</ThemedText>
        {profile?.username && (
          <Text style={{ fontSize: 14, marginTop: 2, color: theme.colors.textSecondary }}>
            @{profile.username}
          </Text>
        )}
      </View>
    </View>
  );
};

const SpaceDetailScreen = () => {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, oxyServices } = useAuth();
  const { joinLiveSpace } = useLiveSpace();
  const [space, setSpace] = useState<Space | null>(null);
  const [loading, setLoading] = useState(true);
  const [isJoined, setIsJoined] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const loadSpace = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      const data = await spacesService.getSpace(id);
      setSpace(data);
      if (data && user?.id) {
        setIsJoined(data.participants?.includes(user.id) ?? false);
      }
    } catch (error) {
      console.warn('Failed to load space', error);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadSpace();
  }, [loadSpace]);

  const handleStartSpace = async () => {
    if (!id || !space) return;
    setActionLoading(true);
    const success = await spacesService.startSpace(id);
    if (success) {
      joinLiveSpace(id);
    } else {
      toast.error('Failed to start space');
    }
    setActionLoading(false);
  };

  const handleEndSpace = async () => {
    if (!id || !space) return;
    setActionLoading(true);
    const success = await spacesService.endSpace(id);
    if (success) {
      router.back();
    } else {
      toast.error('Failed to end space');
    }
    setActionLoading(false);
  };

  const handleJoinSpace = async () => {
    if (!id || !space) return;
    joinLiveSpace(id);
  };

  const handleLeaveSpace = async () => {
    if (!id || !space) return;
    setActionLoading(true);
    const success = await spacesService.leaveSpace(id);
    if (success) {
      setIsJoined(false);
      loadSpace();
    } else {
      toast.error('Failed to leave space');
    }
    setActionLoading(false);
  };

  // Resolve user IDs to real profiles (must be before conditional return for hooks rules)
  const allUserIds = [space?.host, ...(space?.participants || []), ...(space?.speakers || [])].filter(Boolean);
  useSpaceUsers(allUserIds);

  const isLive = space?.status === 'live';
  const isScheduled = space?.status === 'scheduled';
  const isEnded = space?.status === 'ended';
  const isHost = space?.host === user?.id;

  if (loading || !space) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Header
          options={{
            title: 'Space',
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => router.back()}>
                <BackArrowIcon size={20} color={theme.colors.text} />
              </IconButton>,
            ],
          }}
        />
        <View style={styles.centerContent}>
          <Loading />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <>
      <SEO title={space.title} description={space.description || 'Join this space'} />
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Header
          options={{
            title: '',
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => router.back()}>
                <BackArrowIcon size={20} color={theme.colors.text} />
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

        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scrollContent}>
          {/* Status Badge */}
          <View style={styles.statusContainer}>
            {isLive && (
              <View style={[styles.statusBadge, { backgroundColor: '#FF4458' }]}>
                <View style={styles.livePulse} />
                <Text style={styles.statusText}>LIVE</Text>
              </View>
            )}
            {isScheduled && (
              <View style={[styles.statusBadge, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="calendar-outline" size={14} color={theme.colors.text} />
                <Text style={[styles.statusText, { color: theme.colors.text }]}>SCHEDULED</Text>
              </View>
            )}
            {isEnded && (
              <View style={[styles.statusBadge, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Text style={[styles.statusText, { color: theme.colors.textSecondary }]}>ENDED</Text>
              </View>
            )}
          </View>

          {/* Title and Description */}
          <View style={styles.headerSection}>
            <ThemedText type="title" style={styles.title}>
              {space.title}
            </ThemedText>
            {space.topic && (
              <Text style={[styles.topic, { color: theme.colors.textSecondary }]}>
                {space.topic}
              </Text>
            )}
            {space.description && (
              <Text style={[styles.description, { color: theme.colors.text }]}>
                {space.description}
              </Text>
            )}
          </View>

          {/* Host Info */}
          <View style={styles.section}>
            <ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
              Host
            </ThemedText>
            <View style={styles.hostCard}>
              <HostInfo hostId={space.host} oxyServices={oxyServices} theme={theme} />
            </View>
          </View>

          {/* Participants */}
          <View style={styles.section}>
            <ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
              Participants ({space.participants?.length || 0})
            </ThemedText>
            <View style={styles.participantsList}>
              {space.participants?.length > 0 ? (
                space.participants.slice(0, 10).map((participantId) => (
                  <View key={participantId} style={styles.participantItem}>
                    <ParticipantAvatar userId={participantId} oxyServices={oxyServices} />
                  </View>
                ))
              ) : (
                <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                  No participants yet
                </Text>
              )}
            </View>
          </View>

          {/* Speakers */}
          {space.speakers && space.speakers.length > 0 && (
            <View style={styles.section}>
              <ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
                Speakers
              </ThemedText>
              <View style={styles.participantsList}>
                {space.speakers.map((speakerId) => (
                  <View key={speakerId} style={styles.participantItem}>
                    <ParticipantAvatar userId={speakerId} oxyServices={oxyServices} />
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Stats */}
          {space.stats && (
            <View style={[styles.statsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
              <View style={styles.statItem}>
                <ThemedText type="defaultSemiBold" style={styles.statValue}>
                  {space.stats.peakListeners || 0}
                </ThemedText>
                <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
                  Peak listeners
                </Text>
              </View>
              <View style={[styles.statDivider, { backgroundColor: theme.colors.border }]} />
              <View style={styles.statItem}>
                <ThemedText type="defaultSemiBold" style={styles.statValue}>
                  {space.stats.totalJoined || 0}
                </ThemedText>
                <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
                  Total joined
                </Text>
              </View>
            </View>
          )}
        </ScrollView>

        {/* Action Buttons */}
        <View style={[styles.actionBar, { backgroundColor: theme.colors.background, borderTopColor: theme.colors.border }]}>
          {isLive && (
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: theme.colors.primary }]}
              onPress={() => joinLiveSpace(id)}
              disabled={actionLoading}
            >
              <Ionicons name="radio" size={20} color={theme.colors.card} />
              <Text style={[styles.primaryButtonText, { color: theme.colors.card }]}>
                Join Live
              </Text>
            </TouchableOpacity>
          )}
          {isHost && isScheduled && (
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: theme.colors.primary }]}
              onPress={handleStartSpace}
              disabled={actionLoading}
            >
              <Ionicons name="play" size={20} color={theme.colors.card} />
              <Text style={[styles.primaryButtonText, { color: theme.colors.card }]}>
                Start Space
              </Text>
            </TouchableOpacity>
          )}
          {!isHost && isScheduled && (
            <View style={[styles.infoButton, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <Ionicons name="time-outline" size={20} color={theme.colors.textSecondary} />
              <Text style={[styles.infoButtonText, { color: theme.colors.textSecondary }]}>
                Space not started yet
              </Text>
            </View>
          )}
          {isHost && isLive && (
            <TouchableOpacity
              style={[styles.dangerButton, { backgroundColor: '#FF4458' }]}
              onPress={handleEndSpace}
              disabled={actionLoading}
            >
              <Ionicons name="stop" size={20} color="#FFFFFF" />
              <Text style={styles.dangerButtonText}>End Space</Text>
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
  centerContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusContainer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    alignItems: 'flex-start',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
  },
  livePulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FFFFFF',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  headerSection: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  title: {
    fontSize: 28,
    marginBottom: 8,
  },
  topic: {
    fontSize: 16,
    marginBottom: 8,
  },
  description: {
    fontSize: 15,
    lineHeight: 22,
    marginTop: 8,
  },
  section: {
    paddingHorizontal: 16,
    marginTop: 24,
  },
  sectionTitle: {
    fontSize: 16,
    marginBottom: 12,
  },
  hostCard: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  hostMeta: {
    fontSize: 14,
    marginTop: 2,
  },
  participantsList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  participantItem: {
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
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
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
  },
  statLabel: {
    fontSize: 13,
    marginTop: 4,
  },
  statDivider: {
    width: 1,
    height: 40,
    marginHorizontal: 16,
  },
  actionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 24,
    gap: 8,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 24,
    borderWidth: 1,
    gap: 8,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  dangerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 24,
    gap: 8,
  },
  dangerButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  infoButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 24,
    gap: 8,
  },
  infoButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});

export default SpaceDetailScreen;
