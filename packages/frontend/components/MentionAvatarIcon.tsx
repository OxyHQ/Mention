import React from 'react';
import { View } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';

interface MentionAvatarIconProps {
  size: number;
}

export function MentionAvatarIcon({ size }: MentionAvatarIconProps) {
  const theme = useTheme();
  return (
    <View style={{
      width: size,
      height: size,
      backgroundColor: theme.colors.primary,
      borderRadius: size / 2,
    }} />
  );
}
