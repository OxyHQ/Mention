import React, { useEffect, useState, useMemo } from 'react';
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
import { useAuth } from '@oxyhq/services';

import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { useTheme } from '@/hooks/useTheme';
import { useSpaceConnection } from '@/hooks/useSpaceConnection';
import { useSpaceAudio } from '@/hooks/useSpaceAudio';
import { useSpaceUsers, getDisplayName, getAvatarUrl } from '@/hooks/useSpaceUsers';
import { useUserById, type UserEntity } from '@/stores/usersStore';
import { spacesService, type Space } from '@/services/spacesService';
import type { SpaceParticipant } from '@/services/spaceSocketService';

// --- Sub-components ---

const RoleBadge = ({
  role,
  theme,
}: {
  role: string;
  theme: any;
}) => {
  if (role === 'host') {
    return (
      <View style={[styles.roleBadge, { backgroundColor: theme.colors.primary }]}>
        <Text style={styles.roleBadgeText}>Host</Text>
      </View>
    );
  }
  if (role === 'speaker') {
    return (
      <View style={[styles.roleBadge, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <Text style={[styles.roleBadgeText, { color: theme.colors.text }]}>Speaker</Text>
      </View>
    );
  }
  return null;
};

const SpeakerTile = ({
  participant,
  isCurrentUser,
  theme,
  userProfile,
  oxyServices,
}: {
  participant: SpaceParticipant;
  isCurrentUser: boolean;
  theme: any;
  userProfile: UserEntity | undefined;
  oxyServices: any;
}) => {
  const displayName = getDisplayName(userProfile, participant.userId, isCurrentUser);
  const avatarUri = getAvatarUrl(userProfile, oxyServices);

  return (
    <View style={styles.speakerTile}>
      <View
        style={[
          styles.avatarRing,
          !participant.isMuted && {
            borderColor: theme.colors.primary,
            borderWidth: 3,
          },
        ]}
      >
        <Avatar
          size={64}
          source={avatarUri}
          label={displayName[0]?.toUpperCase()}
        />
        {participant.isMuted && (
          <View style={[styles.muteIndicator, { backgroundColor: '#FF4458' }]}>
            <Ionicons name="mic-off" size={12} color="#FFFFFF" />
          </View>
        )}
      </View>
      <Text
        style={[styles.speakerName, { color: theme.colors.text }]}
        numberOfLines={1}
      >
        {displayName}
      </Text>
      <RoleBadge role={participant.role} theme={theme} />
    </View>
  );
};

const ListenerAvatar = ({
  participant,
  userProfile,
  oxyServices,
}: {
  participant: SpaceParticipant;
  userProfile: UserEntity | undefined;
  oxyServices: any;
}) => {
  const displayName = getDisplayName(userProfile, participant.userId, false);
  const avatarUri = getAvatarUrl(userProfile, oxyServices);

  return (
    <View style={styles.listenerItem}>
      <Avatar
        size={40}
        source={avatarUri}
        label={displayName[0]?.toUpperCase()}
      />
    </View>
  );
};

// --- Wrapper components that use hooks for per-participant profile resolution ---

const ConnectedSpeakerTile = ({ participant, isCurrentUser, theme, oxyServices }: {
  participant: SpaceParticipant; isCurrentUser: boolean; theme: any; oxyServices: any;
}) => {
  const userProfile = useUserById(participant.userId);
  return <SpeakerTile participant={participant} isCurrentUser={isCurrentUser} theme={theme} userProfile={userProfile} oxyServices={oxyServices} />;
};

const ConnectedListenerAvatar = ({ participant, oxyServices }: {
  participant: SpaceParticipant; oxyServices: any;
}) => {
  const userProfile = useUserById(participant.userId);
  return <ListenerAvatar participant={participant} userProfile={userProfile} oxyServices={oxyServices} />;
};

const ConnectedRequestRow = ({ request, theme, oxyServices, onApprove, onDeny }: {
  request: { userId: string; requestedAt: string }; theme: any; oxyServices: any;
  onApprove: (userId: string) => void; onDeny: (userId: string) => void;
}) => {
  const userProfile = useUserById(request.userId);
  const displayName = getDisplayName(userProfile, request.userId, false);
  const avatarUri = getAvatarUrl(userProfile, oxyServices);

  return (
    <View style={[styles.requestRow, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
      <Avatar size={36} source={avatarUri} label={displayName[0]?.toUpperCase()} />
      <Text style={[styles.requestName, { color: theme.colors.text }]} numberOfLines={1}>
        {displayName}
      </Text>
      <TouchableOpacity onPress={() => onApprove(request.userId)} style={[styles.approveBtn, { backgroundColor: theme.colors.primary }]}>
        <Ionicons name="checkmark" size={18} color="#FFFFFF" />
      </TouchableOpacity>
      <TouchableOpacity onPress={() => onDeny(request.userId)} style={[styles.denyBtn, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <Ionicons name="close" size={18} color={theme.colors.text} />
      </TouchableOpacity>
    </View>
  );
};

// --- Main Screen ---

const LiveSpaceScreen = () => {
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, oxyServices } = useAuth();
  const [space, setSpace] = useState<Space | null>(null);

  // Fetch space metadata
  useEffect(() => {
    if (id) {
      spacesService.getSpace(id).then(setSpace);
    }
  }, [id]);

  // Real-time connection
  const {
    isConnected,
    participants,
    myRole,
    isMuted,
    speakerRequests,
    join,
    leave,
    toggleMute,
    requestToSpeak,
    approveSpeaker,
    denySpeaker,
    isSpaceEnded,
  } = useSpaceConnection({ spaceId: id!, enabled: !!id });

  // Audio
  const { isRecording, permissionGranted, requestPermission } = useSpaceAudio({
    spaceId: id!,
    isSpeaker: myRole === 'speaker' || myRole === 'host',
    isMuted,
    isConnected,
  });

  // Auto-join when connected
  useEffect(() => {
    if (isConnected && id) {
      join();
    }
  }, [isConnected, id, join]);

  // Request mic permission when becoming speaker
  useEffect(() => {
    if ((myRole === 'speaker' || myRole === 'host') && !permissionGranted) {
      requestPermission();
    }
  }, [myRole, permissionGranted, requestPermission]);

  // Handle space ended
  useEffect(() => {
    if (isSpaceEnded) {
      Alert.alert('Space Ended', 'The host has ended this space.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
    }
  }, [isSpaceEnded]);

  const handleLeave = () => {
    leave();
    router.back();
  };

  const handleEndSpace = async () => {
    if (!id) return;
    await spacesService.endSpace(id);
    leave();
    router.back();
  };

  // Resolve participant user IDs to real profiles
  const participantIds = useMemo(() => participants.map((p) => p.userId), [participants]);
  useSpaceUsers(participantIds);

  // Separate speakers/host and listeners
  const speakers = participants.filter(
    (p) => p.role === 'host' || p.role === 'speaker'
  );
  const listeners = participants.filter((p) => p.role === 'listener');

  const isHost = myRole === 'host';
  const canSpeak = myRole === 'host' || myRole === 'speaker';

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
    >
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity onPress={handleLeave} style={styles.headerButton}>
          <Ionicons name="chevron-down" size={24} color={theme.colors.text} />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <View style={[styles.liveBadge, { backgroundColor: '#FF4458' }]}>
            <View style={styles.livePulse} />
            <Text style={styles.liveText}>LIVE</Text>
          </View>
          <Text style={[styles.listenerCount, { color: theme.colors.textSecondary }]}>
            {participants.length} in room
          </Text>
        </View>

        <View style={styles.headerRight}>
          {isHost && (
            <TouchableOpacity onPress={handleEndSpace} style={styles.endButton}>
              <Text style={styles.endButtonText}>End</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Space Info */}
      <View style={styles.spaceInfo}>
        <ThemedText type="title" style={styles.spaceTitle} numberOfLines={2}>
          {space?.title || 'Space'}
        </ThemedText>
        {space?.topic && (
          <Text style={[styles.spaceTopic, { color: theme.colors.textSecondary }]}>
            {space.topic}
          </Text>
        )}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scrollContent}>
        {/* Speakers Grid */}
        <View style={styles.speakerGrid}>
          {speakers.map((p) => (
            <ConnectedSpeakerTile
              key={p.userId}
              participant={p}
              isCurrentUser={p.userId === user?.id}
              theme={theme}
              oxyServices={oxyServices}
            />
          ))}
        </View>

        {/* Listeners Section */}
        {listeners.length > 0 && (
          <View style={styles.listenerSection}>
            <Text
              style={[
                styles.listenerHeader,
                { color: theme.colors.textSecondary },
              ]}
            >
              Listeners ({listeners.length})
            </Text>
            <View style={styles.listenerGrid}>
              {listeners.map((p) => (
                <ConnectedListenerAvatar key={p.userId} participant={p} oxyServices={oxyServices} />
              ))}
            </View>
          </View>
        )}

        {/* Speaker Requests (host only) */}
        {isHost && speakerRequests.length > 0 && (
          <View style={styles.requestsSection}>
            <Text
              style={[
                styles.requestsHeader,
                { color: theme.colors.textSecondary },
              ]}
            >
              Requests to speak
            </Text>
            {speakerRequests.map((r) => (
              <ConnectedRequestRow
                key={r.userId}
                request={r}
                theme={theme}
                oxyServices={oxyServices}
                onApprove={approveSpeaker}
                onDeny={denySpeaker}
              />
            ))}
          </View>
        )}
      </ScrollView>

      {/* Bottom Control Bar */}
      <View
        style={[
          styles.controlBar,
          { backgroundColor: theme.colors.card, borderTopColor: theme.colors.border },
        ]}
      >
        {/* Mic / Request button */}
        {canSpeak ? (
          <TouchableOpacity style={styles.controlItem} onPress={toggleMute}>
            <View
              style={[
                styles.controlCircle,
                {
                  backgroundColor: isMuted
                    ? theme.colors.backgroundSecondary
                    : theme.colors.primary,
                },
              ]}
            >
              <Ionicons
                name={isMuted ? 'mic-off' : 'mic'}
                size={24}
                color={isMuted ? theme.colors.text : '#FFFFFF'}
              />
            </View>
            <Text style={[styles.controlLabel, { color: theme.colors.textSecondary }]}>
              {isMuted ? 'Unmute' : 'Mute'}
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.controlItem} onPress={requestToSpeak}>
            <View
              style={[
                styles.controlCircle,
                { backgroundColor: theme.colors.backgroundSecondary },
              ]}
            >
              <Ionicons name="hand-left" size={24} color={theme.colors.text} />
            </View>
            <Text style={[styles.controlLabel, { color: theme.colors.textSecondary }]}>
              Request
            </Text>
          </TouchableOpacity>
        )}

        {/* People count */}
        <View style={styles.controlItem}>
          <View
            style={[
              styles.controlCircle,
              { backgroundColor: theme.colors.backgroundSecondary },
            ]}
          >
            <Ionicons name="people" size={24} color={theme.colors.text} />
          </View>
          <Text style={[styles.controlLabel, { color: theme.colors.textSecondary }]}>
            {participants.length}
          </Text>
        </View>

        {/* Leave button */}
        <TouchableOpacity style={styles.controlItem} onPress={handleLeave}>
          <View style={[styles.leaveCircle, { backgroundColor: '#FF4458' }]}>
            <Ionicons name="exit-outline" size={24} color="#FFFFFF" />
          </View>
          <Text style={[styles.controlLabel, { color: theme.colors.textSecondary }]}>
            Leave
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerButton: {
    padding: 4,
  },
  headerCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  headerRight: {
    minWidth: 40,
    alignItems: 'flex-end',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 5,
  },
  livePulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FFFFFF',
  },
  liveText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  listenerCount: {
    fontSize: 14,
    fontWeight: '500',
  },
  endButton: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#FF44581A',
  },
  endButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FF4458',
  },
  spaceInfo: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  spaceTitle: {
    fontSize: 22,
    lineHeight: 28,
  },
  spaceTopic: {
    fontSize: 14,
    marginTop: 4,
  },
  scrollContent: {
    paddingBottom: 120,
  },
  // Speaker grid
  speakerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingTop: 16,
  },
  speakerTile: {
    width: '25%',
    alignItems: 'center',
    marginBottom: 20,
  },
  avatarRing: {
    borderRadius: 40,
    padding: 2,
    borderWidth: 3,
    borderColor: 'transparent',
    position: 'relative',
  },
  muteIndicator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  speakerName: {
    fontSize: 12,
    fontWeight: '500',
    marginTop: 6,
    textAlign: 'center',
    maxWidth: 80,
  },
  roleBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 2,
  },
  roleBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  // Listeners
  listenerSection: {
    paddingHorizontal: 16,
    marginTop: 8,
  },
  listenerHeader: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  listenerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  listenerItem: {
    marginBottom: 4,
  },
  // Speaker requests
  requestsSection: {
    paddingHorizontal: 16,
    marginTop: 24,
  },
  requestsHeader: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  requestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
    gap: 10,
  },
  requestName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
  },
  approveBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  denyBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Bottom controls
  controlBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingTop: 12,
    paddingBottom: 32,
    paddingHorizontal: 24,
    borderTopWidth: 1,
    gap: 32,
  },
  controlItem: {
    alignItems: 'center',
    gap: 4,
  },
  controlCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leaveCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlLabel: {
    fontSize: 11,
    fontWeight: '500',
  },
});

export default LiveSpaceScreen;
