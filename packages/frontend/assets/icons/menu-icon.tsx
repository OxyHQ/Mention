import React from 'react';
import { Path } from 'react-native-svg';
import { IconSvg } from '@/assets/icons/IconSvg';
import { ViewStyle } from 'react-native';

export const MenuIcon = ({ color = 'currentColor', size = 24, style, className }: { color?: string; size?: number; style?: ViewStyle; className?: string }) => {
  return (
    <IconSvg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }} className={className}>
      <Path
        d="M2 6a1 1 0 0 1 1-1h18a1 1 0 1 1 0 2H3a1 1 0 0 1-1-1Zm0 6a1 1 0 0 1 1-1h18a1 1 0 1 1 0 2H3a1 1 0 0 1-1-1Zm0 6a1 1 0 0 1 1-1h18a1 1 0 1 1 0 2H3a1 1 0 0 1-1-1Z"
        fill={color}
      />
    </IconSvg>
  );
};
