import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';

import { useAgoraConfig } from '../context/AgoraConfigContext';

interface MiniRoomBarProps {
  title: string;
  participantCount: number;
  isMuted: boolean;
  canSpeak: boolean;
  activeSpeakerCount?: number;
  onExpand: () => void;
  onToggleMute: () => void;
  onLeave: () => void;
}

export const MINI_BAR_HEIGHT = 64;

export function MiniRoomBar({
  title,
  participantCount,
  isMuted,
  canSpeak,
  activeSpeakerCount = 0,
  onExpand,
  onToggleMute,
  onLeave,
}: MiniRoomBarProps) {
  const { useTheme } = useAgoraConfig();
  const theme = useTheme();

  const pulseScale = useSharedValue(1);

  useEffect(() => {
    if (activeSpeakerCount > 0) {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.15, { duration: 500, easing: Easing.out(Easing.ease) }),
          withTiming(1, { duration: 500, easing: Easing.in(Easing.ease) }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(pulseScale);
      pulseScale.value = withTiming(1, { duration: 200 });
    }
  }, [activeSpeakerCount, pulseScale]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
  }));

  const subtitleText = activeSpeakerCount > 0
    ? `${activeSpeakerCount} speaking`
    : `${participantCount} listening`;

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onExpand}
      style={styles.container}
    >
      <Animated.View style={[styles.liveIndicator, indicatorStyle]}>
        <View style={styles.liveDot} />
      </Animated.View>

      <View style={styles.info}>
        <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
          {title || 'Room'}
        </Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
          {subtitleText}
        </Text>
      </View>

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
            <MaterialCommunityIcons
              name={isMuted ? 'microphone-off' : 'microphone'}
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
          <MaterialCommunityIcons name="close" size={16} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    height: MINI_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
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
