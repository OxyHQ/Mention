import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { ThemedView } from '@/components/ThemedView';
import { ThemedText } from '@/components/ThemedText';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/common/EmptyState';
import Avatar from '@/components/Avatar';
import SEO from '@/components/SEO';

import { useTheme } from '@/hooks/useTheme';
import { useSpaceUsers, getAvatarUrl } from '@/hooks/useSpaceUsers';
import { useUserById } from '@/stores/usersStore';
import { useLiveSpace } from '@/context/LiveSpaceContext';
import { spacesService, type Space } from '@/services/spacesService';
import { useAuth } from '@oxyhq/services';

const SpaceCard = ({ space, onPress, oxyServices }: { space: Space; onPress: () => void; oxyServices: any }) => {
  const theme = useTheme();
  const hostProfile = useUserById(space.host);
  const isLive = space.status === 'live';
  const isScheduled = space.status === 'scheduled';

  const hostName = hostProfile?.username
    ? `@${hostProfile.username}`
    : (typeof hostProfile?.name === 'object' ? hostProfile?.name?.full : typeof hostProfile?.name === 'string' ? hostProfile?.name : null)
      || space.host?.slice(0, 10)
      || 'Unknown';
  const hostAvatarUri = getAvatarUrl(hostProfile, oxyServices);

  return (
    <TouchableOpacity
      style={[
        styles.spaceCard,
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
        },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.spaceCardHeader}>
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <ThemedText type="defaultSemiBold" style={styles.spaceTitle} numberOfLines={1}>
              {space.title}
            </ThemedText>
            {isLive && (
              <View style={[styles.liveBadge, { backgroundColor: '#FF4458' }]}>
                <View style={styles.livePulse} />
                <Text style={styles.liveText}>LIVE</Text>
              </View>
            )}
            {isScheduled && (
              <View style={[styles.scheduledBadge, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="calendar-outline" size={12} color={theme.colors.textSecondary} />
                <Text style={[styles.scheduledText, { color: theme.colors.textSecondary }]}>SCHEDULED</Text>
              </View>
            )}
          </View>

          {space.topic && (
            <Text style={[styles.spaceTopic, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              {space.topic}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.spaceCardFooter}>
        <View style={styles.participantsRow}>
          <Ionicons name="people" size={16} color={theme.colors.textSecondary} />
          <Text style={[styles.participantCount, { color: theme.colors.textSecondary }]}>
            {space.participants?.length || 0} listening
          </Text>
        </View>

        <View style={styles.spacerDot}>
          <Text style={{ color: theme.colors.textSecondary }}>•</Text>
        </View>

        {hostAvatarUri && (
          <Avatar size={16} source={hostAvatarUri} style={{ marginRight: 4 }} />
        )}
        <Text style={[styles.hostText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {hostName}
        </Text>
      </View>
    </TouchableOpacity>
  );
};

const SpacesScreen = () => {
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const { joinLiveSpace } = useLiveSpace();
  const [liveSpaces, setLiveSpaces] = useState<Space[]>([]);
  const [scheduledSpaces, setScheduledSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadSpaces = useCallback(async () => {
    try {
      setLoading(true);
      const [live, scheduled] = await Promise.all([
        spacesService.getSpaces('live'),
        spacesService.getSpaces('scheduled'),
      ]);
      setLiveSpaces(live);
      setScheduledSpaces(scheduled);
    } catch (error) {
      console.warn('Failed to load spaces', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadSpaces();
  }, [loadSpaces]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadSpaces();
  }, [loadSpaces]);

  // Resolve all host IDs to user profiles
  const allHostIds = [...liveSpaces, ...scheduledSpaces].map((s) => s.host).filter(Boolean);
  useSpaceUsers(allHostIds);

  const hasSpaces = liveSpaces.length > 0 || scheduledSpaces.length > 0;

  return (
    <>
      <SEO title="Spaces" description="Join live audio conversations" />
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Header
          options={{
            title: 'Spaces',
            rightComponents: [
              <TouchableOpacity
                key="create"
                onPress={() => router.push('/spaces/create')}
                style={[styles.createButton, { backgroundColor: theme.colors.primary }]}
              >
                <Ionicons name="add" size={20} color={theme.colors.card} />
                <Text style={[styles.createButtonText, { color: theme.colors.card }]}>Create</Text>
              </TouchableOpacity>,
            ],
          }}
          hideBottomBorder={false}
          disableSticky={false}
        />

        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.colors.primary}
            />
          }
          contentContainerStyle={styles.scrollContent}
        >
          {!loading && !hasSpaces ? (
            <EmptyState
              title="No spaces available"
              subtitle="Create a space to start a live audio conversation or schedule one for later"
              icon={{
                name: 'radio',
                size: 48,
              }}
              action={{
                label: 'Create Space',
                onPress: () => router.push('/spaces/create'),
              }}
              containerStyle={styles.emptyState}
            />
          ) : (
            <>
              {liveSpaces.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <View style={[styles.sectionIcon, { backgroundColor: '#FF4458' }]}>
                      <Ionicons name="radio" size={18} color="#FFFFFF" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <ThemedText type="subtitle">Live Now</ThemedText>
                      <Text style={[styles.sectionSubtitle, { color: theme.colors.textSecondary }]}>
                        Join the conversation
                      </Text>
                    </View>
                  </View>
                  {liveSpaces.map((space) => (
                    <SpaceCard
                      key={space._id}
                      space={space}
                      oxyServices={oxyServices}
                      onPress={() => joinLiveSpace(space._id)}
                    />
                  ))}
                </View>
              )}

              {scheduledSpaces.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <View style={[styles.sectionIcon, { backgroundColor: theme.colors.primary }]}>
                      <Ionicons name="calendar" size={18} color={theme.colors.card} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <ThemedText type="subtitle">Upcoming</ThemedText>
                      <Text style={[styles.sectionSubtitle, { color: theme.colors.textSecondary }]}>
                        Scheduled spaces
                      </Text>
                    </View>
                  </View>
                  {scheduledSpaces.map((space) => (
                    <SpaceCard
                      key={space._id}
                      space={space}
                      oxyServices={oxyServices}
                      onPress={() => router.push(`/spaces/${space._id}`)}
                    />
                  ))}
                </View>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </>
  );
};

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 24,
  },
  section: {
    marginTop: 16,
    paddingHorizontal: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  sectionSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  spaceCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  spaceCardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  spaceTitle: {
    fontSize: 16,
    flex: 1,
    marginRight: 8,
  },
  spaceTopic: {
    fontSize: 14,
    marginTop: 2,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    gap: 4,
  },
  livePulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  liveText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  scheduledBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    gap: 4,
  },
  scheduledText: {
    fontSize: 10,
    fontWeight: '700',
  },
  spaceCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  participantsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  participantCount: {
    fontSize: 13,
  },
  spacerDot: {
    marginHorizontal: 8,
  },
  hostText: {
    fontSize: 13,
    flex: 1,
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 4,
  },
  createButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  emptyState: {
    paddingVertical: 48,
    paddingHorizontal: 20,
  },
});

export default SpacesScreen;
