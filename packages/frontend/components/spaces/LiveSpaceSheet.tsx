import React, { useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { toast } from 'sonner';
import { useAuth } from '@oxyhq/services';

import { ThemedText } from '@/components/ThemedText';
import Avatar from '@/components/Avatar';
import { MiniSpaceBar } from '@/components/spaces/MiniSpaceBar';
import { StreamConfigModal } from '@/components/spaces/StreamConfigModal';
import { useTheme } from '@/hooks/useTheme';
import { useSpaceConnection, StreamInfo } from '@/hooks/useSpaceConnection';
import { useSpaceAudio } from '@/hooks/useSpaceAudio';
import { useSpaceUsers, getDisplayName, getAvatarUrl } from '@/hooks/useSpaceUsers';
import { useUserById, type UserEntity } from '@/stores/usersStore';
import { spacesService, type Space } from '@/services/spacesService';
import { getCachedFileDownloadUrl } from '@/utils/imageUrlCache';
import type { SpaceParticipant } from '@/services/spaceSocketService';

// --- Sub-components ---

const RoleBadge = ({ role, theme }: { role: string; theme: any }) => {
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
          shape="squircle"
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
        shape="squircle"
      />
    </View>
  );
};

// Wrapper components using hooks for per-participant profile resolution
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
      <Avatar size={36} source={avatarUri} shape="squircle" />
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

// --- Main Component ---

interface LiveSpaceSheetProps {
  spaceId: string;
  isExpanded: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  onLeave: () => void;
}

export function LiveSpaceSheet({ spaceId, isExpanded, onCollapse, onExpand, onLeave }: LiveSpaceSheetProps) {
  const theme = useTheme();
  const { user, oxyServices } = useAuth();
  const [space, setSpace] = useState<Space | null>(null);

  // Fetch space metadata
  useEffect(() => {
    if (spaceId) {
      spacesService.getSpace(spaceId).then(setSpace);
    }
  }, [spaceId]);

  // Real-time connection
  const {
    isConnected,
    participants,
    myRole,
    isMuted,
    speakerRequests,
    activeStream,
    join,
    leave,
    toggleMute,
    requestToSpeak,
    approveSpeaker,
    denySpeaker,
    isSpaceEnded,
  } = useSpaceConnection({ spaceId, enabled: !!spaceId });

  // Audio — LiveKit handles WebRTC audio transport
  const { isLiveKitConnected, micPermissionDenied } = useSpaceAudio({
    spaceId,
    isSpeaker: myRole === 'speaker' || myRole === 'host',
    isMuted,
    isConnected,
  });

  // Auto-join when connected
  useEffect(() => {
    if (isConnected && spaceId) {
      join();
    }
  }, [isConnected, spaceId, join]);

  // Handle space ended
  useEffect(() => {
    if (isSpaceEnded) {
      toast('Space ended', { description: 'The host ended this space' });
      leave();
      onLeave();
    }
  }, [isSpaceEnded]);

  const handleLeave = () => {
    leave();
    onLeave();
  };

  const handleEndSpace = async () => {
    if (!spaceId) return;
    const success = await spacesService.endSpace(spaceId);
    if (success) {
      leave();
      onLeave();
    } else {
      toast.error('Failed to end space');
    }
  };

  // Stream modal & loading state
  const [streamConfigVisible, setStreamConfigVisible] = useState(false);
  const [streamLoading, setStreamLoading] = useState(false);

  // Determine if a stream is active (from socket events or initial REST data)
  const effectiveStream: StreamInfo | null = activeStream
    ?? (space?.streamTitle || space?.activeStreamUrl
      ? { title: space.streamTitle, image: space.streamImage, description: space.streamDescription }
      : null);

  // Resolve stream cover image file ID to a URL
  const [streamImageUrl, setStreamImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (effectiveStream?.image) {
      getCachedFileDownloadUrl(oxyServices, effectiveStream.image).then(setStreamImageUrl);
    } else {
      setStreamImageUrl(null);
    }
  }, [effectiveStream?.image, oxyServices]);

  const handleStopStream = async () => {
    if (!spaceId || streamLoading) return;
    setStreamLoading(true);
    try {
      const success = await spacesService.stopStream(spaceId);
      if (success) {
        toast.success('Stream stopped');
      } else {
        toast.error('Failed to stop stream');
      }
    } catch {
      toast.error('Failed to stop stream');
    } finally {
      setStreamLoading(false);
    }
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

  // When collapsed, show mini bar
  if (!isExpanded) {
    return (
      <MiniSpaceBar
        title={space?.title || 'Space'}
        participantCount={participants.length}
        isMuted={isMuted}
        canSpeak={canSpeak}
        onExpand={onExpand}
        onToggleMute={toggleMute}
        onLeave={handleLeave}
      />
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity onPress={onCollapse} style={styles.headerButton}>
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

      {/* Mic permission banner */}
      {micPermissionDenied && canSpeak && (
        <View style={[styles.micBanner, { backgroundColor: '#FFF3CD', borderColor: '#FFE69C' }]}>
          <Ionicons name="mic-off" size={18} color="#856404" />
          <Text style={styles.micBannerText}>
            Microphone access denied. Allow mic permission in your browser settings to speak.
          </Text>
        </View>
      )}

      {/* Active stream card */}
      {effectiveStream && (
        <View style={[styles.streamCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
          {streamImageUrl ? (
            <Image source={{ uri: streamImageUrl }} style={styles.streamCardImage} />
          ) : (
            <View style={[styles.streamCardIconBox, { backgroundColor: '#E8F5E9' }]}>
              <Ionicons name="radio" size={20} color="#2E7D32" />
            </View>
          )}
          <View style={styles.streamCardContent}>
            <Text style={[styles.streamCardTitle, { color: theme.colors.text }]} numberOfLines={1}>
              {effectiveStream.title || 'Live Stream'}
            </Text>
            {effectiveStream.description ? (
              <Text style={[styles.streamCardDesc, { color: theme.colors.textSecondary }]} numberOfLines={2}>
                {effectiveStream.description}
              </Text>
            ) : null}
          </View>
          {isHost && (
            <TouchableOpacity onPress={handleStopStream} disabled={streamLoading} style={styles.streamCardStop}>
              <Ionicons name="close-circle" size={22} color="#C62828" />
            </TouchableOpacity>
          )}
        </View>
      )}

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
              style={[styles.listenerHeader, { color: theme.colors.textSecondary }]}
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
              style={[styles.requestsHeader, { color: theme.colors.textSecondary }]}
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

      {/* Stream Config Modal */}
      <StreamConfigModal
        visible={streamConfigVisible}
        onClose={() => setStreamConfigVisible(false)}
        spaceId={spaceId}
        onStreamStarted={() => {
          spacesService.getSpace(spaceId).then(setSpace);
        }}
      />

      {/* Bottom Control Bar */}
      <View
        style={[
          styles.controlBar,
          { backgroundColor: theme.colors.card, borderTopColor: theme.colors.border },
        ]}
      >
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

        {isHost && !effectiveStream && (
          <TouchableOpacity style={styles.controlItem} onPress={() => setStreamConfigVisible(true)}>
            <View style={[styles.controlCircle, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <Ionicons name="radio" size={24} color={theme.colors.text} />
            </View>
            <Text style={[styles.controlLabel, { color: theme.colors.textSecondary }]}>
              Stream
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.controlItem} onPress={handleLeave}>
          <View style={[styles.leaveCircle, { backgroundColor: '#FF4458' }]}>
            <Ionicons name="exit-outline" size={24} color="#FFFFFF" />
          </View>
          <Text style={[styles.controlLabel, { color: theme.colors.textSecondary }]}>
            Leave
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

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
  micBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  micBannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: '#856404',
  },
  scrollContent: {
    paddingBottom: 120,
  },
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
    borderRadius: 20, // squircle: ~64 * 0.25 + padding
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
  controlBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingTop: 12,
    paddingBottom: 24,
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
  streamCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 4,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  streamCardImage: {
    width: 44,
    height: 44,
    borderRadius: 8,
  },
  streamCardIconBox: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streamCardContent: {
    flex: 1,
    gap: 2,
  },
  streamCardTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  streamCardDesc: {
    fontSize: 12,
  },
  streamCardStop: {
    padding: 4,
  },
});
