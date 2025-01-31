import React from 'react';
import Svg, { Path, Line, Polygon } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';


export const Search = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <Path fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 10.5A8.5 8.5 0 1 1 10.5 2a8.5 8.5 0 0 1 8.5 8.5Z"></Path>
      <Line fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" x1="16.511" x2="22" y1="16.511" y2="22"></Line>
    </Svg>
  );
};

export const SearchActive = ({ color = colors.primaryColor, size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <Path fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M18.5 10.5a8 8 0 1 1-8-8 8 8 0 0 1 8 8Z"></Path>
      <Line fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" x1="16.511" x2="21.643" y1="16.511" y2="21.643"></Line>
    </Svg>
  );
};
