import React from 'react';
import { Path, G } from 'react-native-svg';
import { IconSvg } from '@/assets/icons/IconSvg';
import { ViewStyle } from 'react-native';
export const CloseIcon = ({ color = 'currentColor', size = 24, style, className }: { color?: string; size?: number; style?: ViewStyle; className?: string }) => {
  return (
    <IconSvg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }} className={className}>
      <G>
        <Path fill={color} d="M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"></Path>
      </G>
    </IconSvg>
  );
};
