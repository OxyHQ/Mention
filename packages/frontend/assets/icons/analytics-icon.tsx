import React from 'react';
import Svg, { Path, Line, Polygon, Rect } from 'react-native-svg';
import { ViewStyle } from 'react-native';
export const AnalyticsIcon = ({ color = 'currentColor', size = 26, style, className }: { color?: string; size?: number; style?: ViewStyle; className?: string }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }} className={className}>
      <Rect fill="none" height="20" rx="5" stroke={color} strokeWidth="2" width="20" x="2" y="2"></Rect>
      <Rect height="12" rx="1" width="2" x="11" y="6" fill={color}></Rect>
      <Rect height="9" rx="1" width="2" x="15" y="9" fill={color}></Rect>
      <Rect height="5" rx="1" width="2" x="7" y="13" fill={color}></Rect>
    </Svg>
  );
};

export const AnalyticsIconActive = ({ color = 'currentColor', size = 26, style, className }: { color?: string; size?: number; style?: ViewStyle; className?: string }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }} className={className}>
<Rect fill="none" height="20" rx="5" stroke={color} strokeWidth="2" width="20" x="2" y="2"></Rect>
      <Rect height="12" rx="1" width="2.5" x="11" y="6" fill={color}></Rect>
      <Rect height="9" rx="1" width="2.5" x="15" y="9" fill={color}></Rect>
      <Rect height="5" rx="1" width="2.5" x="7" y="13" fill={color}></Rect>
    </Svg>
  );
};