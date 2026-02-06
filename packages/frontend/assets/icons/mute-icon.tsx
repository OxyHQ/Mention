import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export const MuteIcon = ({ color = colors.primaryColor, size = 24, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <Path
        d="M18 8.59V1.2L12.71 6H5.5c-.28 0-.5.22-.5.5v11c0 .28.22.5.5.5H12l6.71 6.71 1.41-1.41-2.3-2.3L21 17.41l-2.41-2.41zM12 19.29L8.41 16H7V8h4.41l3.59-3.59v8.17l-3 3z"
        fill={color}
      />
      <Path
        d="M20 12c0 .34-.03.67-.08 1l1.48 1.48c.14-.48.22-.98.22-1.48 0-3.31-2.69-6-6-6-.34 0-.67.03-1 .08l1.48 1.48c.17-.01.34-.02.52-.02 2.21 0 4 1.79 4 4z"
        fill={color}
      />
    </Svg>
  );
};
