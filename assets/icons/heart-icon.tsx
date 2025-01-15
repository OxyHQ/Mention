import React from 'react';
import Svg, { Path, Line, Polygon } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export const HeartIcon = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="2 2 26 26" width={size} height={size} style={{ ...style }}>
      <Path stroke={color} fill="transparent" d="M5.5 12.8568C5.5 17.224 9.22178 21.5299 15.0332 25.2032C15.3554 25.397 15.7401 25.5909 16 25.5909C16.2703 25.5909 16.655 25.397 16.9668 25.2032C22.7782 21.5299 26.5 17.224 26.5 12.8568C26.5 9.11212 23.8698 6.5 20.4599 6.5C18.4847 6.5 16.9356 7.39792 16 8.74479C15.0851 7.40812 13.5257 6.5 11.5401 6.5C8.14059 6.5 5.5 9.11212 5.5 12.8568Z" stroke-width="2.2"></Path>
    </Svg>
  );
};

export const HeartIconActive = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="2 2 26 26" width={size} height={size} style={{ ...style }}>
      <Path fill={color} d="M1.34375 7.03125L1.34375 7.04043C1.34374 7.54211 1.34372 8.26295 1.6611 9.15585C1.9795 10.0516 2.60026 11.0779 3.77681 12.2544C5.59273 14.0704 7.58105 15.5215 8.33387 16.0497C8.73525 16.3313 9.26573 16.3313 9.66705 16.0496C10.4197 15.5213 12.4074 14.0703 14.2232 12.2544C15.3997 11.0779 16.0205 10.0516 16.3389 9.15585C16.6563 8.26296 16.6563 7.54211 16.6562 7.04043V7.03125C16.6562 4.73466 15.0849 2.75 12.6562 2.75C11.5214 2.75 10.6433 3.28244 9.99228 3.95476C9.59009 4.37012 9.26356 4.8491 9 5.31533C8.73645 4.8491 8.40991 4.37012 8.00772 3.95476C7.35672 3.28244 6.47861 2.75 5.34375 2.75C2.9151 2.75 1.34375 4.73466 1.34375 7.03125Z"></Path>
    </Svg>
  );
};