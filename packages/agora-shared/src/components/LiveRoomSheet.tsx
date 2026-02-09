import React, { useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  type ViewStyle,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useAuth } from '@oxyhq/services';

import { useAgoraConfig } from '../context/AgoraConfigContext';
import { MiniRoomBar } from './MiniRoomBar';
import { StreamConfigPanel } from './StreamConfigPanel';
import { InsightsPanel } from './InsightsPanel';
import { PanelHeader } from './PanelHeader';
import { useRoomConnection } from '../hooks/useRoomConnection';
import { useRoomAudio } from '../hooks/useRoomAudio';
import { useRoomUsers, getDisplayName, getAvatarUrl } from '../hooks/useRoomUsers';
import type { RoomParticipant, Room, StreamInfo, UserEntity, AgoraTheme } from '../types';

type ActivePanel = null | 'stream' | 'insights' | 'settings';

type AvatarComponentType = React.ComponentType<{ size: number; source?: string; shape?: string; style?: ViewStyle }>;
type CachedFileDownloadUrlSyncFn = (oxyServices: unknown, fileId: string, variant?: string) => string;

const RoleBadge = ({ role, theme }: { role: string; theme: AgoraTheme }) => {
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
  AvatarComponent,
  getCachedFileDownloadUrlSync,
}: {
  participant: RoomParticipant;
  isCurrentUser: boolean;
  theme: AgoraTheme;
  userProfile: UserEntity | undefined;
  oxyServices: unknown;
  AvatarComponent: AvatarComponentType;
  getCachedFileDownloadUrlSync: CachedFileDownloadUrlSyncFn;
}) => {
  const displayName = getDisplayName(userProfile, participant.userId, isCurrentUser);
  const avatarUri = getAvatarUrl(userProfile, oxyServices, getCachedFileDownloadUrlSync);

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
        <AvatarComponent size={64} source={avatarUri} shape="squircle" />
        {participant.isMuted && (
          <View style={[styles.muteIndicator, { backgroundColor: '#FF4458' }]}>
            <MaterialCommunityIcons name="microphone-off" size={12} color="#FFFFFF" />
          </View>
        )}
      </View>
      <Text style={[styles.speakerName, { color: theme.colors.text }]} numberOfLines={1}>
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
  AvatarComponent,
  getCachedFileDownloadUrlSync,
}: {
  participant: RoomParticipant;
  userProfile: UserEntity | undefined;
  oxyServices: unknown;
  AvatarComponent: AvatarComponentType;
  getCachedFileDownloadUrlSync: CachedFileDownloadUrlSyncFn;
}) => {
  return (
    <View style={styles.listenerItem}>
      <AvatarComponent size={40} source={getAvatarUrl(userProfile, oxyServices, getCachedFileDownloadUrlSync)} shape="squircle" />
    </View>
  );
};

const ConnectedSpeakerTile = ({ participant, isCurrentUser, theme, oxyServices, AvatarComponent, getCachedFileDownloadUrlSync, useUserById }: {
  participant: RoomParticipant; isCurrentUser: boolean; theme: AgoraTheme; oxyServices: unknown;
  AvatarComponent: AvatarComponentType; getCachedFileDownloadUrlSync: CachedFileDownloadUrlSyncFn; useUserById: (id: string | undefined) => UserEntity | undefined;
}) => {
  const userProfile = useUserById(participant.userId);
  return <SpeakerTile participant={participant} isCurrentUser={isCurrentUser} theme={theme} userProfile={userProfile} oxyServices={oxyServices} AvatarComponent={AvatarComponent} getCachedFileDownloadUrlSync={getCachedFileDownloadUrlSync} />;
};

const ConnectedListenerAvatar = ({ participant, oxyServices, AvatarComponent, getCachedFileDownloadUrlSync, useUserById }: {
  participant: RoomParticipant; oxyServices: unknown;
  AvatarComponent: AvatarComponentType; getCachedFileDownloadUrlSync: CachedFileDownloadUrlSyncFn; useUserById: (id: string | undefined) => UserEntity | undefined;
}) => {
  const userProfile = useUserById(participant.userId);
  return <ListenerAvatar participant={participant} userProfile={userProfile} oxyServices={oxyServices} AvatarComponent={AvatarComponent} getCachedFileDownloadUrlSync={getCachedFileDownloadUrlSync} />;
};

const ConnectedRequestRow = ({ request, theme, oxyServices, onApprove, onDeny, AvatarComponent, getCachedFileDownloadUrlSync, useUserById }: {
  request: { userId: string; requestedAt: string }; theme: AgoraTheme; oxyServices: unknown;
  onApprove: (userId: string) => void; onDeny: (userId: string) => void;
  AvatarComponent: AvatarComponentType; getCachedFileDownloadUrlSync: CachedFileDownloadUrlSyncFn; useUserById: (id: string | undefined) => UserEntity | undefined;
}) => {
  const userProfile = useUserById(request.userId);
  const displayName = getDisplayName(userProfile, request.userId, false);
  const avatarUri = getAvatarUrl(userProfile, oxyServices, getCachedFileDownloadUrlSync);

  return (
    <View style={[styles.requestRow, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}>
      <AvatarComponent size={36} source={avatarUri} shape="squircle" />
      <Text style={[styles.requestName, { color: theme.colors.text }]} numberOfLines={1}>
        {displayName}
      </Text>
      <TouchableOpacity onPress={() => onApprove(request.userId)} style={[styles.approveBtn, { backgroundColor: theme.colors.primary }]}>
        <MaterialCommunityIcons name="check" size={18} color="#FFFFFF" />
      </TouchableOpacity>
      <TouchableOpacity onPress={() => onDeny(request.userId)} style={[styles.denyBtn, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <MaterialCommunityIcons name="close" size={18} color={theme.colors.text} />
      </TouchableOpacity>
    </View>
  );
};

interface LiveRoomSheetProps {
  roomId: string;
  isExpanded: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  onLeave: () => void;
}

export function LiveRoomSheet({ roomId, isExpanded, onCollapse, onExpand, onLeave }: LiveRoomSheetProps) {
  const { useTheme, useUserById, AvatarComponent, agoraService, toast, getCachedFileDownloadUrl, getCachedFileDownloadUrlSync, onRoomChanged } = useAgoraConfig();
  const theme = useTheme();
  const { user, oxyServices } = useAuth();
  const [room, setRoom] = useState<Room | null>(null);

  useEffect(() => {
    if (roomId) {
      agoraService.getRoom(roomId).then(setRoom);
    }
  }, [roomId]);

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
    isRoomEnded,
  } = useRoomConnection({ roomId, enabled: !!roomId });

  const isRoomLive = room?.status === 'live';
  const { isLiveKitConnected, micPermissionDenied } = useRoomAudio({
    roomId,
    isSpeaker: myRole === 'speaker' || myRole === 'host',
    isMuted,
    isConnected: isConnected && isRoomLive,
  });

  useEffect(() => {
    if (isConnected && roomId) {
      join();
    }
  }, [isConnected, roomId, join]);

  useEffect(() => {
    if (isRoomEnded) {
      toast('Room ended');
      leave();
      onLeave();
    }
  }, [isRoomEnded]);

  const handleLeave = () => {
    leave();
    onLeave();
  };

  const handleStopRoom = async () => {
    if (!roomId) return;
    const success = await agoraService.stopRoom(roomId);
    if (success) {
      onRoomChanged?.(roomId);
      leave();
      onLeave();
    } else {
      toast.error('Failed to stop session');
    }
  };

  const handleDeleteRoom = async () => {
    if (!roomId) return;
    const success = await agoraService.deleteRoom(roomId);
    if (success) {
      onRoomChanged?.(roomId);
      leave();
      onLeave();
      toast.success('Room deleted');
    } else {
      toast.error('Failed to delete room');
    }
  };

  const [startingRoom, setStartingRoom] = useState(false);
  const handleStartRoom = async () => {
    if (!roomId || startingRoom) return;
    setStartingRoom(true);
    try {
      const success = await agoraService.startRoom(roomId);
      if (success) {
        const updated = await agoraService.getRoom(roomId);
        if (updated) setRoom(updated);
        onRoomChanged?.(roomId);
        toast.success('Room is now live!');
      } else {
        toast.error('Failed to start room');
      }
    } catch {
      toast.error('Failed to start room');
    } finally {
      setStartingRoom(false);
    }
  };

  const [activePanel, setActivePanel] = useState<ActivePanel>(null);
  const [streamLoading, setStreamLoading] = useState(false);

  const effectiveStream: StreamInfo | null = activeStream
    ?? (room?.streamTitle || room?.activeStreamUrl
      ? { title: room.streamTitle, image: room.streamImage, description: room.streamDescription }
      : null);

  const [streamImageUrl, setStreamImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (effectiveStream?.image) {
      getCachedFileDownloadUrl(oxyServices, effectiveStream.image).then(setStreamImageUrl);
    } else {
      setStreamImageUrl(null);
    }
  }, [effectiveStream?.image, oxyServices]);

  const handleStopStream = async () => {
    if (!roomId || streamLoading) return;
    setStreamLoading(true);
    try {
      const success = await agoraService.stopStream(roomId);
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

  const participantIds = useMemo(() => participants.map((p) => p.userId), [participants]);
  useRoomUsers(participantIds);

  const speakers = participants.filter(
    (p) => p.role === 'host' || p.role === 'speaker'
  );
  const listeners = participants.filter((p) => p.role === 'listener');

  const userId = user?.id;
  const isHost = myRole === 'host' || (!!userId && room?.host === userId);
  const canSpeak = myRole === 'host' || myRole === 'speaker';

  if (!isExpanded) {
    return (
      <MiniRoomBar
        title={room?.title || 'Room'}
        participantCount={participants.length}
        isMuted={isMuted}
        canSpeak={canSpeak}
        onExpand={onExpand}
        onToggleMute={toggleMute}
        onLeave={handleLeave}
      />
    );
  }

  if (activePanel === 'stream') {
    return (
      <StreamConfigPanel
        roomId={roomId}
        roomStatus={room?.status}
        initialRtmpUrl={room?.rtmpUrl ?? undefined}
        initialStreamKey={room?.rtmpStreamKey ?? undefined}
        onClose={() => setActivePanel(null)}
        onStreamStarted={() => {
          agoraService.getRoom(roomId).then(setRoom);
          onRoomChanged?.(roomId);
          setActivePanel(null);
        }}
      />
    );
  }

  if (activePanel === 'insights') {
    return (
      <InsightsPanel
        room={room}
        participants={participants}
        theme={theme}
        onClose={() => setActivePanel(null)}
      />
    );
  }

  if (activePanel === 'settings') {
    return (
      <View style={styles.container}>
        <PanelHeader title="Room Settings" theme={theme} onBack={() => setActivePanel(null)} />
        <View style={styles.settingsContent}>
          <TouchableOpacity
            style={styles.settingsItem}
            onPress={handleDeleteRoom}
          >
            <MaterialCommunityIcons name="delete-outline" size={22} color="#FF4458" />
            <View style={styles.settingsItemText}>
              <Text style={[styles.settingsItemTitle, { color: '#FF4458' }]}>Delete Room</Text>
              <Text style={[styles.settingsItemDesc, { color: theme.colors.textSecondary }]}>
                Permanently remove this room
              </Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { borderBottomColor: `${theme.colors.border}80` }]}>
        <TouchableOpacity onPress={onCollapse} style={styles.headerButton}>
          <MaterialCommunityIcons name="chevron-down" size={24} color={theme.colors.text} />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          {isRoomLive ? (
            <View style={[styles.liveBadge, { backgroundColor: '#FF4458' }]}>
              <View style={styles.livePulse} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          ) : (
            <View style={[styles.liveBadge, { backgroundColor: theme.colors.textSecondary }]}>
              <Text style={styles.liveText}>SCHEDULED</Text>
            </View>
          )}
          <Text style={[styles.listenerCount, { color: theme.colors.textSecondary }]}>
            {participants.length} in room
          </Text>
        </View>

        <View style={styles.headerRight}>
          {isHost && isRoomLive && (
            <TouchableOpacity onPress={handleStopRoom} style={styles.endButton}>
              <Text style={styles.endButtonText}>End</Text>
            </TouchableOpacity>
          )}
          {isHost && !isRoomLive && room?.status === 'scheduled' && (
            <TouchableOpacity
              onPress={handleStartRoom}
              disabled={startingRoom}
              style={[styles.endButton, { backgroundColor: theme.colors.primary }]}
            >
              <Text style={[styles.endButtonText, { color: '#FFFFFF' }]}>
                {startingRoom ? 'Starting...' : 'Go Live'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={styles.roomInfo}>
        <Text style={[styles.roomTitle, { color: theme.colors.text }]} numberOfLines={2}>
          {room?.title || 'Room'}
        </Text>
        {room?.topic && (
          <Text style={[styles.roomTopic, { color: theme.colors.textSecondary }]}>
            {room.topic}
          </Text>
        )}
      </View>

      {micPermissionDenied && canSpeak && (
        <View style={[styles.micBanner, { backgroundColor: '#FFF3CD', borderColor: '#FFE69C' }]}>
          <MaterialCommunityIcons name="microphone-off" size={18} color="#856404" />
          <Text style={styles.micBannerText}>
            Microphone access denied. Allow mic permission in your browser settings to speak.
          </Text>
        </View>
      )}

      {effectiveStream && (
        <View style={[styles.streamCard, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}>
          {streamImageUrl ? (
            <Image source={{ uri: streamImageUrl }} style={styles.streamCardImage} />
          ) : (
            <View style={[styles.streamCardIconBox, { backgroundColor: '#E8F5E9' }]}>
              <MaterialCommunityIcons name="radio" size={20} color="#2E7D32" />
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
              <MaterialCommunityIcons name="close-circle" size={22} color="#C62828" />
            </TouchableOpacity>
          )}
        </View>
      )}

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.speakerGrid}>
          {speakers.map((p) => (
            <ConnectedSpeakerTile
              key={p.userId}
              participant={p}
              isCurrentUser={p.userId === userId}
              theme={theme}
              oxyServices={oxyServices}
              AvatarComponent={AvatarComponent}
              getCachedFileDownloadUrlSync={getCachedFileDownloadUrlSync}
              useUserById={useUserById}
            />
          ))}
        </View>

        {listeners.length > 0 && (
          <View style={styles.listenerSection}>
            <Text style={[styles.listenerHeader, { color: theme.colors.textSecondary }]}>
              Listeners ({listeners.length})
            </Text>
            <View style={styles.listenerGrid}>
              {listeners.map((p) => (
                <ConnectedListenerAvatar
                  key={p.userId}
                  participant={p}
                  oxyServices={oxyServices}
                  AvatarComponent={AvatarComponent}
                  getCachedFileDownloadUrlSync={getCachedFileDownloadUrlSync}
                  useUserById={useUserById}
                />
              ))}
            </View>
          </View>
        )}

        {isHost && speakerRequests.length > 0 && (
          <View style={styles.requestsSection}>
            <Text style={[styles.requestsHeader, { color: theme.colors.textSecondary }]}>
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
                AvatarComponent={AvatarComponent}
                getCachedFileDownloadUrlSync={getCachedFileDownloadUrlSync}
                useUserById={useUserById}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <View
        style={[
          styles.controlBar,
          { borderTopColor: theme.colors.border },
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
              <MaterialCommunityIcons
                name={isMuted ? 'microphone-off' : 'microphone'}
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
              <MaterialCommunityIcons name="hand-back-left" size={24} color={theme.colors.text} />
            </View>
            <Text style={[styles.controlLabel, { color: theme.colors.textSecondary }]}>
              Request
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.controlItem} onPress={() => setActivePanel('insights')}>
          <View
            style={[
              styles.controlCircle,
              { backgroundColor: theme.colors.backgroundSecondary },
            ]}
          >
            <MaterialCommunityIcons name="chart-box-outline" size={24} color={theme.colors.text} />
          </View>
          <Text style={[styles.controlLabel, { color: theme.colors.textSecondary }]}>
            Insights
          </Text>
        </TouchableOpacity>

        {isHost && (
          <TouchableOpacity style={styles.controlItem} onPress={() => setActivePanel('stream')}>
            <View style={[styles.controlCircle, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <MaterialCommunityIcons name="radio" size={24} color={theme.colors.text} />
            </View>
            <Text style={[styles.controlLabel, { color: theme.colors.textSecondary }]}>
              Stream
            </Text>
          </TouchableOpacity>
        )}

        {isHost && (
          <TouchableOpacity style={styles.controlItem} onPress={() => setActivePanel('settings')}>
            <View style={[styles.controlCircle, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <MaterialCommunityIcons name="cog-outline" size={24} color={theme.colors.text} />
            </View>
            <Text style={[styles.controlLabel, { color: theme.colors.textSecondary }]}>
              Settings
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.controlItem} onPress={handleLeave}>
          <View style={[styles.leaveCircle, { backgroundColor: '#FF4458' }]}>
            <MaterialCommunityIcons name="exit-run" size={24} color="#FFFFFF" />
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
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerButton: { padding: 4 },
  headerCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  headerRight: { minWidth: 40, alignItems: 'flex-end' },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 5,
  },
  livePulse: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFFFFF' },
  liveText: { fontSize: 12, fontWeight: '700', color: '#FFFFFF' },
  listenerCount: { fontSize: 14, fontWeight: '500' },
  endButton: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#FF44581A',
  },
  endButtonText: { fontSize: 15, fontWeight: '600', color: '#FF4458' },
  roomInfo: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  roomTitle: { fontSize: 32, fontWeight: 'bold', lineHeight: 38 },
  roomTopic: { fontSize: 14, marginTop: 4 },
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
  micBannerText: { flex: 1, fontSize: 13, fontWeight: '500', color: '#856404' },
  scrollContent: { paddingBottom: 120 },
  speakerGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
    paddingTop: 16,
  },
  speakerTile: { width: '25%', alignItems: 'center', marginBottom: 20 },
  avatarRing: {
    borderRadius: 19,
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
  roleBadgeText: { fontSize: 10, fontWeight: '600', color: '#FFFFFF' },
  listenerSection: { paddingHorizontal: 16, marginTop: 8 },
  listenerHeader: { fontSize: 14, fontWeight: '600', marginBottom: 12 },
  listenerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  listenerItem: { marginBottom: 4 },
  requestsSection: { paddingHorizontal: 16, marginTop: 24 },
  requestsHeader: { fontSize: 14, fontWeight: '600', marginBottom: 12 },
  requestRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
    gap: 10,
  },
  requestName: { flex: 1, fontSize: 14, fontWeight: '500' },
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
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    gap: 20,
  },
  controlItem: { alignItems: 'center', gap: 4 },
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
  controlLabel: { fontSize: 11, fontWeight: '500' },
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
  streamCardImage: { width: 44, height: 44, borderRadius: 8 },
  streamCardIconBox: {
    width: 44,
    height: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streamCardContent: { flex: 1, gap: 2 },
  streamCardTitle: { fontSize: 14, fontWeight: '600' },
  streamCardDesc: { fontSize: 12 },
  streamCardStop: { padding: 4 },
  settingsContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  settingsItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
  },
  settingsItemText: { flex: 1 },
  settingsItemTitle: { fontSize: 16, fontWeight: '600' },
  settingsItemDesc: { fontSize: 13, marginTop: 2 },
});
