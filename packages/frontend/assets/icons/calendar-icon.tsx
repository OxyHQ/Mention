import React from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { IconProps } from './types';

export const CalendarIcon: React.FC<IconProps> = ({ size = 20, color = '#000' }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Rect x={3} y={4} width={18} height={17} rx={2} stroke={color} strokeWidth={1.5} />
    <Path d="M8 2.5v3" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    <Path d="M16 2.5v3" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    <Path d="M3 9h18" stroke={color} strokeWidth={1.5} />
    <Rect x={7} y={12} width={3} height={3} rx={0.75} fill={color} />
  </Svg>
);
