import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { colors } from '@/styles/colors';


export const EmojiIcon = ({
  color = colors.primaryColor, // Replace with your primary color
  size = 26,
  style
}: {
  color?: string;
  size?: number;
  style?: ViewStyle
}) => {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={style}
    >
      <Path
        fill={color}
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10S2 17.523 2 12Zm8-5a1 1 0 0 1 1 1v3a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1Zm4 0a1 1 0 0 1 1 1v3a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1Zm-5.894 7.803a1 1 0 0 1 1.341-.447c1.719.859 3.387.859 5.106 0a1 1 0 1 1 .894 1.788c-2.281 1.141-4.613 1.141-6.894 0a1 1 0 0 1-.447-1.341Z"
      />
    </Svg>
  );
};
