import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, StyleProp, ViewStyle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useAuth } from '@oxyhq/services';

import { useAgoraConfig } from '../context/AgoraConfigContext';
import { useRoomUsers, getAvatarUrl } from '../hooks/useRoomUsers';

// --- Utility helpers ---

function formatCompact(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(num);
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function getTimeLabel(room: RoomCardProps['room']): string {
  if (room.status === 'ended' && room.startedAt && room.endedAt) {
    return `${formatDuration(room.startedAt, room.endedAt)}  ·  ${formatDate(room.endedAt)}`;
  }
  if (room.status === 'live' && room.startedAt) {
    return `Live  ·  Started ${formatDate(room.startedAt)}`;
  }
  if (room.status === 'scheduled' && room.scheduledStart) {
    return formatDate(room.scheduledStart);
  }
  if (room.createdAt) {
    return formatDate(room.createdAt);
  }
  return '';
}

// --- Constants ---

const ROOM_TYPE_META: Record<string, { icon: 'account-voice' | 'broadcast'; label: string; color: string }> = {
  stage: { icon: 'account-voice', label: 'Stage', color: '#3B82F6' },
  broadcast: { icon: 'broadcast', label: 'Broadcast', color: '#FF6B35' },
};

const MAX_SPEAKER_AVATARS = 4;
const SPEAKER_AVATAR_SIZE = 44;

// --- Types ---

interface RoomCardProps {
  room: {
    _id: string;
    title: string;
    status: 'scheduled' | 'live' | 'ended';
    type?: 'talk' | 'stage' | 'broadcast';
    topic?: string;
    participants?: string[];
    speakers?: string[];
    host: string;
    houseId?: string | null;
    scheduledStart?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    createdAt?: string;
    stats?: { peakListeners?: number; totalJoined?: number };
  };
  onPress?: () => void;
  variant?: 'default' | 'compact';
  house?: { name: string; avatarUrl?: string } | null;
  hostName?: string;
  hostAvatarUri?: string;
  onMenuPress?: () => void;
  onSave?: () => void;
  isSaved?: boolean;
  style?: StyleProp<ViewStyle>;
}

// --- Component ---

export const RoomCard: React.FC<RoomCardProps> = ({
  room,
  onPress,
  variant = 'default',
  house,
  hostName: hostNameProp,
  hostAvatarUri: hostAvatarUriProp,
  onMenuPress,
  onSave,
  isSaved,
  style,
}) => {
  const { useTheme, useUserById, AvatarComponent, getCachedFileDownloadUrlSync } = useAgoraConfig();
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const hostProfile = useUserById(room.host);

  const isLive = room.status === 'live';
  const isScheduled = room.status === 'scheduled';
  const isCompact = variant === 'compact';

  // Resolve host display
  const hostName = hostNameProp
    ?? (hostProfile?.username
      ? `@${hostProfile.username}`
      : (typeof hostProfile?.name === 'object' ? hostProfile?.name?.full : typeof hostProfile?.name === 'string' ? hostProfile?.name : null)
        || room.host?.slice(0, 10)
        || 'Unknown');
  const hostAvatarUri = hostAvatarUriProp ?? getAvatarUrl(hostProfile, oxyServices, getCachedFileDownloadUrlSync);

  // Resolve speaker avatars (default variant only)
  const speakerIds = useMemo(() => {
    if (isCompact) return [];
    const ids = room.speakers?.length ? room.speakers : [room.host];
    return ids.slice(0, MAX_SPEAKER_AVATARS);
  }, [room.speakers, room.host, isCompact]);

  useRoomUsers(speakerIds);

  const typeMeta = room.type && room.type !== 'talk' ? ROOM_TYPE_META[room.type] : null;
  const listenerCount = room.participants?.length || room.stats?.totalJoined || 0;
  const timeLabel = getTimeLabel(room);

  // --- Compact variant (kept simple) ---
  if (isCompact) {
    return (
      <TouchableOpacity
        style={[styles.compactCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }, style]}
        onPress={onPress}
        activeOpacity={onPress ? 0.7 : 1}
        disabled={!onPress}
      >
        <View style={styles.compactHeader}>
          {house && (
            <Text style={[styles.compactHouseName, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              {house.name.toUpperCase()}
            </Text>
          )}
          <Text style={[styles.compactTitle, { color: theme.colors.text }]} numberOfLines={2}>
            {room.title}
          </Text>
          {(isLive || isScheduled || typeMeta) && (
            <View style={styles.compactBadgeRow}>
              {isLive && (
                <View style={[styles.liveBadge, { backgroundColor: '#FF4458' }]}>
                  <View style={styles.livePulse} />
                  <Text style={styles.liveText}>LIVE</Text>
                </View>
              )}
              {isScheduled && (
                <View style={[styles.scheduledBadge, { backgroundColor: theme.colors.backgroundSecondary }]}>
                  <MaterialCommunityIcons name="calendar" size={10} color={theme.colors.textSecondary} />
                  <Text style={[styles.scheduledText, { color: theme.colors.textSecondary }]}>SCHEDULED</Text>
                </View>
              )}
              {typeMeta && (
                <View style={[styles.typeBadge, { backgroundColor: typeMeta.color + '20' }]}>
                  <MaterialCommunityIcons name={typeMeta.icon} size={10} color={typeMeta.color} />
                  <Text style={[styles.typeText, { color: typeMeta.color }]}>{typeMeta.label}</Text>
                </View>
              )}
            </View>
          )}
        </View>
        <View style={styles.compactFooter}>
          <MaterialCommunityIcons name="account-group" size={14} color={theme.colors.textSecondary} />
          <Text style={[styles.compactCount, { color: theme.colors.textSecondary }]}>
            {listenerCount} listening
          </Text>
          <Text style={{ color: theme.colors.textSecondary, fontSize: 10 }}>•</Text>
          {hostAvatarUri && (
            <AvatarComponent size={14} source={hostAvatarUri} shape="squircle" style={{ marginRight: 2 }} />
          )}
          <Text style={[styles.compactHost, { color: theme.colors.textSecondary }]} numberOfLines={1}>
            {hostName}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

  // --- Default variant ---
  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }, style]}
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
      disabled={!onPress}
    >
      {/* Section 1: House header + menu */}
      {(house || onMenuPress) && (
        <View style={styles.houseRow}>
          {house && (
            <>
              <MaterialCommunityIcons name="home" size={16} color={theme.colors.primary} />
              <Text style={[styles.houseName, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                {house.name.toUpperCase()}
              </Text>
            </>
          )}
          <View style={{ flex: 1 }} />
          {onMenuPress && (
            <TouchableOpacity onPress={onMenuPress} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MaterialCommunityIcons name="dots-horizontal" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Section 2: Title + status badges */}
      <View>
        <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={2}>
          {room.title}
        </Text>
        {(isLive || isScheduled || typeMeta) && (
          <View style={styles.badgeRow}>
            {isLive && (
              <View style={[styles.liveBadge, { backgroundColor: '#FF4458' }]}>
                <View style={styles.livePulse} />
                <Text style={styles.liveText}>LIVE</Text>
              </View>
            )}
            {isScheduled && (
              <View style={[styles.scheduledBadge, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <MaterialCommunityIcons name="calendar" size={12} color={theme.colors.textSecondary} />
                <Text style={[styles.scheduledText, { color: theme.colors.textSecondary }]}>SCHEDULED</Text>
              </View>
            )}
            {typeMeta && (
              <View style={[styles.typeBadge, { backgroundColor: typeMeta.color + '20' }]}>
                <MaterialCommunityIcons name={typeMeta.icon} size={10} color={typeMeta.color} />
                <Text style={[styles.typeText, { color: typeMeta.color }]}>{typeMeta.label}</Text>
              </View>
            )}
          </View>
        )}
      </View>

      {/* Section 3: Speaker avatars + listener count */}
      <SpeakerRow
        speakerIds={speakerIds}
        listenerCount={listenerCount}
        theme={theme}
      />

      {/* Section 4: Metadata + save */}
      {(timeLabel || onSave) && (
        <View style={styles.metaRow}>
          {timeLabel ? (
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>{timeLabel}</Text>
          ) : (
            <View />
          )}
          {onSave && (
            <TouchableOpacity onPress={onSave} style={styles.saveButton} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MaterialCommunityIcons
                name={isSaved ? 'bookmark' : 'bookmark-outline'}
                size={18}
                color={isSaved ? theme.colors.primary : theme.colors.textSecondary}
              />
              <Text style={[styles.saveText, { color: isSaved ? theme.colors.primary : theme.colors.textSecondary }]}>
                Save
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
};

// --- Speaker row sub-component ---

function SpeakerRow({
  speakerIds,
  listenerCount,
  theme,
}: {
  speakerIds: string[];
  listenerCount: number;
  theme: ReturnType<ReturnType<typeof useAgoraConfig>['useTheme']>;
}) {
  return (
    <View style={styles.avatarRow}>
      {speakerIds.map((id) => (
        <SpeakerAvatar key={id} userId={id} />
      ))}
      {listenerCount > 0 && (
        <View style={[styles.countTile, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border }]}>
          <Text style={[styles.countTileText, { color: theme.colors.textSecondary }]}>
            +{formatCompact(listenerCount)}
          </Text>
        </View>
      )}
    </View>
  );
}

function SpeakerAvatar({ userId }: { userId: string }) {
  const { useUserById, AvatarComponent, getCachedFileDownloadUrlSync, useTheme } = useAgoraConfig();
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const profile = useUserById(userId);
  const avatarUri = getAvatarUrl(profile, oxyServices, getCachedFileDownloadUrlSync);

  return (
    <View style={[styles.avatarRing, { borderColor: theme.colors.border }]}>
      <AvatarComponent
        size={SPEAKER_AVATAR_SIZE}
        source={avatarUri}
        shape="squircle"
      />
    </View>
  );
}

// --- Styles ---

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
    gap: 12,
  },
  compactCard: {
    width: 200,
    minHeight: 140,
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    justifyContent: 'space-between',
  },

  // House header
  houseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  houseName: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // Title
  title: {
    fontSize: 32,
    fontWeight: '700',
    lineHeight: 38,
  },

  // Badges
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
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
  typeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    gap: 3,
  },
  typeText: {
    fontSize: 9,
    fontWeight: '700',
  },

  // Speaker avatars
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  avatarRing: {
    borderRadius: 14,
    padding: 2,
    borderWidth: 2,
  },
  countTile: {
    width: SPEAKER_AVATAR_SIZE + 4,
    height: SPEAKER_AVATAR_SIZE + 4,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  countTileText: {
    fontSize: 14,
    fontWeight: '700',
  },

  // Metadata
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metaText: {
    fontSize: 13,
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  saveText: {
    fontSize: 13,
    fontWeight: '500',
  },

  // Compact variant
  compactHeader: {
    flex: 1,
  },
  compactHouseName: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  compactTitle: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  compactBadgeRow: {
    flexDirection: 'row',
    marginTop: 4,
    gap: 4,
    flexWrap: 'wrap',
  },
  compactFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
  },
  compactCount: {
    fontSize: 11,
  },
  compactHost: {
    fontSize: 11,
    flex: 1,
  },
});

export default RoomCard;
