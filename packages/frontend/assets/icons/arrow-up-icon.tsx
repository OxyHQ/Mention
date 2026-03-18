import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ViewStyle } from 'react-native';

export const ArrowUp = ({ color = 'currentColor', size = 24, style, className }: { color?: string; size?: number; style?: ViewStyle; className?: string }) => {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }} className={className}>
      <Path
        d="M11 20V6.164l-4.293 4.293a1 1 0 1 1-1.414-1.414l5.293-5.293.151-.138a2 2 0 0 1 2.677.138l5.293 5.293.068.076a1 1 0 0 1-1.406 1.406l-.076-.068L13 6.164V20a1 1 0 0 1-2 0Z"
        fill={color}
      />
    </Svg>
  );
};
