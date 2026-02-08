import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { ViewStyle } from 'react-native';

export const User = ({ color = '#000', size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 26 26" width={size} height={size} style={{ ...style }}>
      <Circle cx="13" cy="7.25" r="4" stroke={color} strokeWidth="2.5" fill="transparent" />
      <Path
        d="M6.26678 23.75H19.744C21.603 23.75 22.5 23.2186 22.5 22.0673C22.5 19.3712 18.8038 15.75 13 15.75C7.19625 15.75 3.5 19.3712 3.5 22.0673C3.5 23.2186 4.39704 23.75 6.26678 23.75Z"
        stroke={color}
        strokeWidth="2.5"
        fill="transparent"
      />
    </Svg>
  );
};

export const UserActive = ({ color = '#000', size = 26, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  return (
    <Svg viewBox="0 0 26 26" width={size} height={size} style={{ ...style }}>
      <Circle cx="13" cy="7.25" r="4" stroke={color} strokeWidth="2.5" fill={color} />
      <Path
        d="M6.26678 23.75H19.744C21.603 23.75 22.5 23.2186 22.5 22.0673C22.5 19.3712 18.8038 15.75 13 15.75C7.19625 15.75 3.5 19.3712 3.5 22.0673C3.5 23.2186 4.39704 23.75 6.26678 23.75Z"
        stroke={color}
        strokeWidth="2.5"
        fill={color}
      />
    </Svg>
  );
};
