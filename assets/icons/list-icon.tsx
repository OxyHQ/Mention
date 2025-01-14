import React from 'react';
import Svg, { Path, Line, Polygon } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';


export const List = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <Path fill={color} fill-rule="evenodd" clip-rule="evenodd" d="M6 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2ZM3 7a3 3 0 1 1 6 0 3 3 0 0 1-6 0Zm9 0a1 1 0 0 1 1-1h7a1 1 0 1 1 0 2h-7a1 1 0 0 1-1-1Zm-6 9a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-3 1a3 3 0 1 1 6 0 3 3 0 0 1-6 0Zm9 0a1 1 0 0 1 1-1h7a1 1 0 1 1 0 2h-7a1 1 0 0 1-1-1Z"></Path>
    </Svg>
  );
};

export const ListActive = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <Path fill={color} fill-rule="evenodd" clip-rule="evenodd" d="M3 7a3 3 0 1 1 6 0 3 3 0 0 1-6 0Zm0 10a3 3 0 1 1 6 0 3 3 0 0 1-6 0Zm10-1a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2h-7Zm-1-9a1 1 0 0 1 1-1h7a1 1 0 1 1 0 2h-7a1 1 0 0 1-1-1Z"></Path>
    </Svg>
  );
};
