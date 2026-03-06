import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, StyleProp, ViewStyle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useAuth } from '@oxyhq/services';

import { useAgoraConfig } from '../context/AgoraConfigContext';
import { getAvatarUrl, getDisplayName } from '../hooks/useRoomUsers';
import type { Recording } from '../validation';

// --- Helpers ---

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDurationMs(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// --- Types ---

interface RecordingCardProps {
  recording: Recording;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

// --- Component ---

export const RecordingCard: React.FC<RecordingCardProps> = ({ recording, onPress, style }) => {
  const { useTheme, useUserById, AvatarComponent, getCachedFileDownloadUrlSync } = useAgoraConfig();
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const hostProfile = useUserById(recording.host);
  const hostAvatarUri = getAvatarUrl(hostProfile, oxyServices, getCachedFileDownloadUrlSync);
  const hostName = getDisplayName(hostProfile, recording.host);

  const duration = recording.durationMs ? formatDurationMs(recording.durationMs) : null;
  const date = formatDate(recording.createdAt);
  const listeners = recording.participantIds?.length || 0;

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }, style]}
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
      disabled={!onPress}
    >
      <View style={styles.row}>
        {/* Play icon */}
        <View style={[styles.playIcon, { backgroundColor: theme.colors.primary + '15' }]}>
          <MaterialCommunityIcons name="play-circle" size={28} color={theme.colors.primary} />
        </View>

        {/* Content */}
        <View style={styles.content}>
          <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
            {recording.roomTitle}
          </Text>
          <View style={styles.meta}>
            {hostAvatarUri && (
              <AvatarComponent size={16} source={hostAvatarUri} shape="squircle" style={{ marginRight: 4 }} />
            )}
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              {hostName}
            </Text>
            <Text style={[styles.dot, { color: theme.colors.textSecondary }]}>·</Text>
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>{date}</Text>
          </View>
        </View>

        {/* Duration / Stats */}
        <View style={styles.rightCol}>
          {duration && (
            <Text style={[styles.duration, { color: theme.colors.text }]}>{duration}</Text>
          )}
          {listeners > 0 && (
            <View style={styles.listenersRow}>
              <MaterialCommunityIcons name="account-group" size={12} color={theme.colors.textSecondary} />
              <Text style={[styles.listenersText, { color: theme.colors.textSecondary }]}>{listeners}</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
};

// --- Styles ---

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    width: 280,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  playIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    gap: 4,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaText: {
    fontSize: 12,
  },
  dot: {
    fontSize: 10,
    marginHorizontal: 4,
  },
  rightCol: {
    alignItems: 'flex-end',
    gap: 4,
  },
  duration: {
    fontSize: 13,
    fontWeight: '600',
  },
  listenersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  listenersText: {
    fontSize: 11,
  },
});

export default RecordingCard;
