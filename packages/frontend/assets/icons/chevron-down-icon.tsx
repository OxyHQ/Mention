import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ViewStyle } from 'react-native';

export const ChevronDownIcon = ({ color = 'currentColor', size = 24, style, className }: { color?: string; size?: number; style?: ViewStyle; className?: string }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }} className={className}>
      <Path
        d="M12.71 15.29l4.59-4.59c.39-.39.39-1.02 0-1.41-.39-.39-1.02-.39-1.41 0L12 13.17 8.12 9.29c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41l4.59 4.59c.39.39 1.02.39 1.41 0z"
        fill={color}
      />
    </Svg>
  );
};
