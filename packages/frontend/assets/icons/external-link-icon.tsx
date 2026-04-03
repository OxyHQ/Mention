import React from 'react';
import Svg, { Path } from 'react-native-svg';
import type { IconProps } from './types';

export const ExternalLinkIcon: React.FC<IconProps> = ({ size = 24, color = 'currentColor', className }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <Path
      d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M15 3h6v6"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M10 14L21 3"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);
