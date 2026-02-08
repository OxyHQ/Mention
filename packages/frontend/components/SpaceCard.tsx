import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useUserById } from '@/stores/usersStore';
import { getAvatarUrl } from '@/hooks/useSpaceUsers';
import { useAuth } from '@oxyhq/services';
import Avatar from '@/components/Avatar';

interface SpaceCardProps {
  space: {
    _id: string;
    title: string;
    status: 'scheduled' | 'live' | 'ended';
    topic?: string;
    participants?: string[];
    host: string;
  };
  onPress?: () => void;
  variant?: 'default' | 'compact';
  hostName?: string;
  hostAvatarUri?: string;
  style?: StyleProp<ViewStyle>;
}

const SpaceCard: React.FC<SpaceCardProps> = ({
  space,
  onPress,
  variant = 'default',
  hostName: hostNameProp,
  hostAvatarUri: hostAvatarUriProp,
  style,
}) => {
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const hostProfile = useUserById(space.host);

  const isLive = space.status === 'live';
  const isScheduled = space.status === 'scheduled';

  const hostName = hostNameProp
    ?? (hostProfile?.username
      ? `@${hostProfile.username}`
      : (typeof hostProfile?.name === 'object' ? hostProfile?.name?.full : typeof hostProfile?.name === 'string' ? hostProfile?.name : null)
        || space.host?.slice(0, 10)
        || 'Unknown');
  const hostAvatarUri = hostAvatarUriProp ?? getAvatarUrl(hostProfile, oxyServices);

  const isCompact = variant === 'compact';

  return (
    <TouchableOpacity
      style={[
        isCompact ? styles.compactCard : styles.card,
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
        },
        style,
      ]}
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
      disabled={!onPress}
    >
      <View style={isCompact ? styles.compactHeader : styles.header}>
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Text
              style={[isCompact ? styles.compactTitle : styles.title, { color: theme.colors.text }]}
              numberOfLines={isCompact ? 2 : 1}
            >
              {space.title}
            </Text>
            {!isCompact && isLive && (
              <View style={[styles.liveBadge, { backgroundColor: '#FF4458' }]}>
                <View style={styles.livePulse} />
                <Text style={styles.liveText}>LIVE</Text>
              </View>
            )}
            {!isCompact && isScheduled && (
              <View style={[styles.scheduledBadge, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="calendar-outline" size={12} color={theme.colors.textSecondary} />
                <Text style={[styles.scheduledText, { color: theme.colors.textSecondary }]}>SCHEDULED</Text>
              </View>
            )}
          </View>

          {isCompact && (isLive || isScheduled) && (
            <View style={{ flexDirection: 'row', marginTop: 4 }}>
              {isLive && (
                <View style={[styles.liveBadge, { backgroundColor: '#FF4458' }]}>
                  <View style={styles.livePulse} />
                  <Text style={styles.liveText}>LIVE</Text>
                </View>
              )}
              {isScheduled && (
                <View style={[styles.scheduledBadge, { backgroundColor: theme.colors.backgroundSecondary }]}>
                  <Ionicons name="calendar-outline" size={10} color={theme.colors.textSecondary} />
                  <Text style={[styles.scheduledText, { color: theme.colors.textSecondary }]}>SCHEDULED</Text>
                </View>
              )}
            </View>
          )}

          {space.topic && (
            <Text
              style={[isCompact ? styles.compactTopic : styles.topic, { color: theme.colors.textSecondary }]}
              numberOfLines={1}
            >
              {space.topic}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.footer}>
        <View style={styles.participantsRow}>
          <Ionicons name="people" size={isCompact ? 14 : 16} color={theme.colors.textSecondary} />
          <Text style={[isCompact ? styles.compactCount : styles.count, { color: theme.colors.textSecondary }]}>
            {space.participants?.length || 0} listening
          </Text>
        </View>

        <View style={styles.spacerDot}>
          <Text style={{ color: theme.colors.textSecondary, fontSize: isCompact ? 10 : 13 }}>•</Text>
        </View>

        {hostAvatarUri && (
          <Avatar size={isCompact ? 14 : 16} source={hostAvatarUri} shape="squircle" style={{ marginRight: 4 }} />
        )}
        <Text
          style={[isCompact ? styles.compactHost : styles.host, { color: theme.colors.textSecondary }]}
          numberOfLines={1}
        >
          {hostName}
        </Text>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  compactCard: {
    width: 200,
    minHeight: 140,
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
    justifyContent: 'space-between',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  compactHeader: {
    flex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  compactTitle: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
  },
  topic: {
    fontSize: 14,
    marginTop: 2,
  },
  compactTopic: {
    fontSize: 12,
    marginTop: 4,
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
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  participantsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  count: {
    fontSize: 13,
  },
  compactCount: {
    fontSize: 11,
  },
  spacerDot: {
    marginHorizontal: 8,
  },
  host: {
    fontSize: 13,
    flex: 1,
  },
  compactHost: {
    fontSize: 11,
    flex: 1,
  },
});

export default SpaceCard;
