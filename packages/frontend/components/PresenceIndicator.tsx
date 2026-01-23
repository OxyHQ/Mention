import React, { memo } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { usePresence } from '@/hooks/usePresence';

interface PresenceIndicatorProps {
  userId: string | undefined;
  size?: 'small' | 'medium' | 'large';
  style?: ViewStyle;
  showOffline?: boolean;
}

const SIZES = {
  small: 8,
  medium: 12,
  large: 16,
};

/**
 * Presence indicator component that shows online/offline status
 */
export const PresenceIndicator = memo(function PresenceIndicator({
  userId,
  size = 'medium',
  style,
  showOffline = false,
}: PresenceIndicatorProps) {
  const theme = useTheme();
  const isOnline = usePresence(userId);

  // Don't render if user is offline and showOffline is false
  if (!isOnline && !showOffline) {
    return null;
  }

  const indicatorSize = SIZES[size];

  return (
    <View
      style={[
        styles.indicator,
        {
          width: indicatorSize,
          height: indicatorSize,
          borderRadius: indicatorSize / 2,
          backgroundColor: isOnline ? '#22c55e' : theme.colors.textSecondary,
          borderColor: theme.colors.background,
          borderWidth: size === 'small' ? 1 : 2,
        },
        style,
      ]}
    />
  );
});

const styles = StyleSheet.create({
  indicator: {
    position: 'absolute',
  },
});

export default PresenceIndicator;
