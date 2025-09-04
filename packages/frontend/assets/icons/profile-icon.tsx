import React from 'react';
import { View, ViewStyle } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { IconProps } from './types';
import { colors } from '@/styles/colors';

export const ProfileIcon: React.FC<IconProps> = ({ size = 24, color = '#5baaff' }) => {
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 26 26" fill="none">
        <Circle cx="13" cy="7.25" r="4" stroke={color} strokeWidth="2.5" fill="transparent" />
        <Path
          d="M6.26678 23.75H19.744C21.603 23.75 22.5 23.2186 22.5 22.0673C22.5 19.3712 18.8038 15.75 13 15.75C7.19625 15.75 3.5 19.3712 3.5 22.0673C3.5 23.2186 4.39704 23.75 6.26678 23.75Z"
          stroke={color}
          strokeWidth="2.5"
          fill="transparent"
        />
      </Svg>
    </View>
  );
};

export const ProfileIconActive = ({
  color = colors.primaryColor,
  size = 26,
  style,
}: {
  color?: string;
  size?: number;
  style?: ViewStyle;
}) => {
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 26 26" fill="none">
        <Circle cx="13" cy="7.25" r="4" stroke={color} strokeWidth="2.5" fill={color} />
        <Path
          d="M6.26678 23.75H19.744C21.603 23.75 22.5 23.2186 22.5 22.0673C22.5 19.3712 18.8038 15.75 13 15.75C7.19625 15.75 3.5 19.3712 3.5 22.0673C3.5 23.2186 4.39704 23.75 6.26678 23.75Z"
          stroke={color}
          strokeWidth="2.5"
          fill={color}
        />
      </Svg>
    </View>
  );
};
