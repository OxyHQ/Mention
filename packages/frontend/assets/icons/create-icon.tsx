import React from 'react';
import Svg, { Path } from 'react-native-svg';

export const CreateIcon = ({ color = '#fff', size = 24 }: { color?: string; size?: number }) => (
  <Svg viewBox="0 0 24 24" width={size} height={size}>
    <Path
      d="M13.25 3.00001C13.25 2.30965 12.6904 1.75001 12 1.75001C11.3096 1.75001 10.75 2.30965 10.75 3.00001V10.75H3C2.30964 10.75 1.75 11.3097 1.75 12C1.75 12.6904 2.30964 13.25 3 13.25H10.75V21C10.75 21.6904 11.3096 22.25 12 22.25C12.6904 22.25 13.25 21.6904 13.25 21V13.25H21C21.6904 13.25 22.25 12.6904 22.25 12C22.25 11.3097 21.6904 10.75 21 10.75H13.25V3.00001Z"
      fill={color}
    />
  </Svg>
);
