import React from 'react';
import Svg, { Path, G } from 'react-native-svg';
import { ViewStyle } from 'react-native';
export const ReportIcon = ({ color = 'currentColor', size = 24, style, className }: { color?: string; size?: number; style?: ViewStyle; className?: string }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }} className={className}>
      <G>
        <Path d="M3 2h18.61l-3.5 7 3.5 7H5v6H3V2zm2 12h13.38l-2.5-5 2.5-5H5v10z" fill={color} />
      </G>
    </Svg>
  );
};
