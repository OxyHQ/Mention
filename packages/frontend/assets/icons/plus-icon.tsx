import React from 'react';
import Svg, { Path, Line, Polygon } from 'react-native-svg';
import { ViewStyle } from 'react-native';

export const Plus = ({ color = 'currentColor', size = 26, style, className }: { color?: string; size?: number; style?: ViewStyle; className?: string }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }} className={className}>
      <Path d="M11 11V4h2v7h7v2h-7v7h-2v-7H4v-2h7z"></Path>
    </Svg>
  );
}; 