import React from 'react';
import Svg, { Path, Line, Polygon, Rect } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export const AnalyticsIcon = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <Rect fill="none" height="20" rx="5" stroke={color} stroke-width="2" width="20" x="2" y="2"></Rect>
      <Rect height="12" rx="1" width="2" x="11" y="6" fill={color}></Rect>
      <Rect height="9" rx="1" width="2" x="15" y="9" fill={color}></Rect>
      <Rect height="5" rx="1" width="2" x="7" y="13" fill={color}></Rect>
    </Svg>
  );
};

export const AnalyticsIconActive = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
<Rect fill="none" height="20" rx="5" stroke={color} stroke-width="2" width="20" x="2" y="2"></Rect>
      <Rect height="12" rx="1" width="2.5" x="11" y="6" fill={color}></Rect>
      <Rect height="9" rx="1" width="2.5" x="15" y="9" fill={color}></Rect>
      <Rect height="5" rx="1" width="2.5" x="7" y="13" fill={color}></Rect>
    </Svg>
  );
};