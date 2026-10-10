import React from 'react';
import { Path, Line } from 'react-native-svg';
import { IconSvg } from '@/assets/icons/IconSvg';
import { ViewStyle } from 'react-native';

export const Chat = ({ color = 'currentColor', size = 26, style, className }: { color?: string; size?: number; style?: ViewStyle; className?: string }) => {
  return (
    <IconSvg viewBox="0 0 24 24" width={size} height={size} style={{ ...style, transform: [{ translateY: 2 }] }} className={className}>
      <Path d="M13.973 20.046 21.77 6.928C22.8 5.195 21.55 3 19.535 3H4.466C2.138 3 .984 5.825 2.646 7.456l4.842 4.752 1.723 7.121c.548 2.266 3.571 2.721 4.762.717Z" fill="none" stroke={color} strokeLinejoin="round" strokeWidth="2"></Path>
      <Line fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" x1="7.488" x2="15.515" y1="12.208" y2="7.641"></Line>
    </IconSvg>
  );
};
