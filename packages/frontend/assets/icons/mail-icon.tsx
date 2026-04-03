import React from 'react';
import Svg, { Path } from 'react-native-svg';
import type { IconProps } from './types';

export const MailIcon: React.FC<IconProps> = ({ size = 24, color = 'currentColor', className }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
    <Path
      d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M22 6l-10 7L2 6"
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
);
