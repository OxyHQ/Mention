import React from 'react';
import Svg, { Path, G } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';

export const BackArrowIcon = ({ color = colors.primaryColor, size = 24, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <G>
        <Path fill={color} d="M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z"></Path>
      </G>
    </Svg>
  );
};
