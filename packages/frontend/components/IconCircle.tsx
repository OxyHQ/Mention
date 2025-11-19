import React from 'react';
import { View, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { IconProps } from '@/assets/icons/types';

interface IconCircleProps {
  icon: React.ComponentType<IconProps>;
  size?: 'lg' | 'xl';
  style?: ViewStyle;
  iconStyle?: TextStyle;
}

/**
 * IconCircle Component
 * 
 * Displays an icon inside a circular background.
 * Reused from social-app and adapted for Mention's theme system.
 */
export function IconCircle({
  icon: Icon,
  size = 'xl',
  style,
  iconStyle,
}: IconCircleProps) {
  const theme = useTheme();

  const containerSize = size === 'lg' ? 52 : 64;
  const iconSize = size === 'lg' ? 24 : 28;

  return (
    <View
      style={[
        styles.container,
        {
          width: containerSize,
          height: containerSize,
          backgroundColor: theme.colors.primaryLight,
        },
        style,
      ]}>
      <Icon
        size={iconSize}
        color={theme.colors.primary}
        style={iconStyle}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
  },
});

