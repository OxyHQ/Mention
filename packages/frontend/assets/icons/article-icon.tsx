import React from 'react';
import Svg, { Path, Line, Polygon, Rect } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export const ArticleIcon = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <Rect fill="none" height="20.5" rx="4.25" stroke={color} strokeWidth="1.5" width="16.5" x="3.75" y="1.75"></Rect>
      <Rect fill={color} height="1.5" rx="0.75" width="10" x="7" y="7"></Rect>
      <Rect fill={color} height="1.5" rx="0.75" width="10" x="7" y="10"></Rect>
      <Rect fill={color} height="1.5" rx="0.75" width="10" x="7" y="13"></Rect>
      <Rect fill={color} height="1.5" rx="0.75" width="6" x="7" y="16"></Rect>
    </Svg>
  );
};