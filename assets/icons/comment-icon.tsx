import React from 'react';
import Svg, { Path, Line, Polygon } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export const CommentIcon = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 18 18" width={size} height={size} style={{ ...style }}>
      <Path stroke={color} fill="transparent" d="M15.376 13.2177L16.2861 16.7955L12.7106 15.8848C12.6781 15.8848 12.6131 15.8848 12.5806 15.8848C11.3779 16.5678 9.94767 16.8931 8.41995 16.7955C4.94194 16.5353 2.08152 13.7381 1.72397 10.2578C1.2689 5.63919 5.13697 1.76863 9.75264 2.22399C13.2307 2.58177 16.0261 5.41151 16.2861 8.92429C16.4161 10.453 16.0586 11.8841 15.376 13.0876C15.376 13.1526 15.376 13.1852 15.376 13.2177Z" strokeWidth="1.5"></Path>
    </Svg>
  );
};

export const CommentIconActive = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 18 18" width={size} height={size} style={{ ...style }}>
      <Path fill={color} d="M1.34375 7.03125L1.34375 7.04043C1.34374 7.54211 1.34372 8.26295 1.6611 9.15585C1.9795 10.0516 2.60026 11.0779 3.77681 12.2544C5.59273 14.0704 7.58105 15.5215 8.33387 16.0497C8.73525 16.3313 9.26573 16.3313 9.66705 16.0496C10.4197 15.5213 12.4074 14.0703 14.2232 12.2544C15.3997 11.0779 16.0205 10.0516 16.3389 9.15585C16.6563 8.26296 16.6563 7.54211 16.6562 7.04043V7.03125C16.6562 4.73466 15.0849 2.75 12.6562 2.75C11.5214 2.75 10.6433 3.28244 9.99228 3.95476C9.59009 4.37012 9.26356 4.8491 9 5.31533C8.73645 4.8491 8.40991 4.37012 8.00772 3.95476C7.35672 3.28244 6.47861 2.75 5.34375 2.75C2.9151 2.75 1.34375 4.73466 1.34375 7.03125Z"></Path>
    </Svg>
  );
};