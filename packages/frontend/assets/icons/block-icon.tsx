import React from 'react';
import { Path } from 'react-native-svg';
import { IconSvg } from '@/assets/icons/IconSvg';
import { ViewStyle } from 'react-native';

/**
 * Block — the universal circle-with-a-slash. Material Symbols geometry, hence
 * the `0 -960 960 960` viewBox.
 */
export const BlockIcon = ({
  color = 'currentColor',
  size = 24,
  style,
  className,
}: {
  color?: string;
  size?: number;
  style?: ViewStyle;
  className?: string;
}) => {
  return (
    <IconSvg
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      style={{ ...style }}
      className={className}
    >
      <Path
        fill={color}
        d="M308.39-74.65q-79.91-34.57-139.54-94.48-59.63-59.91-94.2-140.04-34.56-80.12-34.56-171.96 0-90.93 34.66-171.03 34.66-80.11 94.06-139.64 59.39-59.53 139.7-93.82 80.31-34.29 171.46-34.29 91.16 0 171.48 34.29t139.72 93.82q59.41 59.53 94.07 139.64 34.67 80.1 34.67 171.03 0 91.84-34.56 171.96-34.57 80.13-94.2 140.04T651.56-74.65Q571.6-40.09 479.95-40.09q-91.65 0-171.56-34.56ZM480-163.04q47.61 0 93-13.74t84.56-41.48L217.13-658.13q-26.61 39.74-40.35 84.85-13.74 45.11-13.74 92.15 0 132.61 92.46 225.35 92.46 92.74 224.5 92.74Zm263.43-141.09q26.05-39.74 39.79-84.85 13.74-45.11 13.74-92.15 0-131.56-92.46-223.69-92.46-92.14-224.5-92.14-47.04 0-91.87 13.18-44.83 13.17-84.56 39.21l439.86 440.44ZM480-481.13Z"
      />
    </IconSvg>
  );
};
