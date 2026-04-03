import React from 'react';
import Svg, { Circle } from 'react-native-svg';
import type { IconProps } from './types';

export const MoreIcon: React.FC<IconProps> = ({ size = 24, color = 'currentColor', className }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <Circle cx="12" cy="12" r="1.5" fill={color} />
    <Circle cx="6" cy="12" r="1.5" fill={color} />
    <Circle cx="18" cy="12" r="1.5" fill={color} />
  </Svg>
);
