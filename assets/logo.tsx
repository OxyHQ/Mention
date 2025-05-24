import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export const LogoIcon = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 388.03 512" width={size} height={size} style={style}>
      <polygon fill={color} points="388.03 512 170.88 512 168.64 509.76 168.64 364.25 85.07 364.25 85.07 509.76 82.83 512 0 512 0 105.31 276.91 0 281.41 1.51 388.03 109.79 388.03 512" />
    </Svg>
  );
};