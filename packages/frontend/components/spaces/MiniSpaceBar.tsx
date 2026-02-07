import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/hooks/useTheme';

interface MiniSpaceBarProps {
  title: string;
  participantCount: number;
  isMuted: boolean;
  canSpeak: boolean;
  onExpand: () => void;
  onToggleMute: () => void;
  onLeave: () => void;
}

export function MiniSpaceBar({
  title,
  participantCount,
  isMuted,
  canSpeak,
  onExpand,
  onToggleMute,
  onLeave,
}: MiniSpaceBarProps) {
  const theme = useTheme();

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onExpand}
      style={[styles.container, { backgroundColor: theme.colors.card, borderTopColor: theme.colors.border }]}
    >
      {/* LIVE indicator */}
      <View style={styles.liveIndicator}>
        <View style={styles.liveDot} />
      </View>

      {/* Title and info */}
      <View style={styles.info}>
        <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
          {title || 'Space'}
        </Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
          {participantCount} listening
        </Text>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        {canSpeak && (
          <TouchableOpacity
            onPress={onToggleMute}
            style={[
              styles.controlButton,
              {
                backgroundColor: isMuted
                  ? theme.colors.backgroundSecondary
                  : theme.colors.primary,
              },
            ]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons
              name={isMuted ? 'mic-off' : 'mic'}
              size={16}
              color={isMuted ? theme.colors.text : '#FFFFFF'}
            />
          </TouchableOpacity>
        )}

        <TouchableOpacity
          onPress={onLeave}
          style={[styles.controlButton, { backgroundColor: '#FF4458' }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="close" size={16} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

const MINI_BAR_HEIGHT = 64;

export { MINI_BAR_HEIGHT };

const styles = StyleSheet.create({
  container: {
    height: MINI_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderTopWidth: 1,
    gap: 12,
  },
  liveIndicator: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#FF4458',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FFFFFF',
  },
  info: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
    marginTop: 1,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  controlButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
