import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import Avatar from '@/components/Avatar';
import SEO from '@/components/SEO';

import { useTheme } from '@/hooks/useTheme';
import { spacesService, type Space } from '@/services/spacesService';
import { useAuth } from '@oxyhq/services';

const SpaceDetailScreen = () => {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
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
      router.replace(`/spaces/live/${id}`);
    } else {
      Alert.alert('Error', 'Failed to start space');
    }
    setActionLoading(false);
  };

  const handleEndSpace = async () => {
    if (!id || !space) return;
    Alert.alert(
      'End Space',
      'Are you sure you want to end this space? This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End',
          style: 'destructive',
          onPress: async () => {
            setActionLoading(true);
            const success = await spacesService.endSpace(id);
            if (success) {
              router.back();
            } else {
              Alert.alert('Error', 'Failed to end space');
            }
            setActionLoading(false);
          },
        },
      ]
    );
  };

  const handleJoinSpace = async () => {
    if (!id || !space) return;
    router.push(`/spaces/live/${id}`);
  };

  const handleLeaveSpace = async () => {
    if (!id || !space) return;
    setActionLoading(true);
    const success = await spacesService.leaveSpace(id);
    if (success) {
      setIsJoined(false);
      loadSpace();
    } else {
      Alert.alert('Error', 'Failed to leave space');
    }
    setActionLoading(false);
  };

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
          <ThemedText>Loading...</ThemedText>
        </View>
      </SafeAreaView>
    );
  }

  const isLive = space.status === 'live';
  const isScheduled = space.status === 'scheduled';
  const isEnded = space.status === 'ended';
  const isHost = space.host === user?.id;

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
              <Avatar size={48} label={space.host?.[0]?.toUpperCase() || 'H'} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <ThemedText type="defaultSemiBold">{space.host || 'Unknown'}</ThemedText>
                <Text style={[styles.hostMeta, { color: theme.colors.textSecondary }]}>Host</Text>
              </View>
            </View>
          </View>

          {/* Participants */}
          <View style={styles.section}>
            <ThemedText type="defaultSemiBold" style={styles.sectionTitle}>
              Participants ({space.participants?.length || 0})
            </ThemedText>
            <View style={styles.participantsList}>
              {space.participants?.length > 0 ? (
                space.participants.slice(0, 10).map((participant, index) => (
                  <View key={index} style={styles.participantItem}>
                    <Avatar size={32} label={participant[0]?.toUpperCase()} />
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
                {space.speakers.map((speaker, index) => (
                  <View key={index} style={styles.participantItem}>
                    <Avatar size={32} label={speaker[0]?.toUpperCase()} />
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
              onPress={() => router.push(`/spaces/live/${id}`)}
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
