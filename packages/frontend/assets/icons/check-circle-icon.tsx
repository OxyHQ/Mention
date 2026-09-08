import React from 'react';
import { Path, G } from 'react-native-svg';
import { IconSvg } from '@/assets/icons/IconSvg';
import { ViewStyle } from 'react-native';

/**
 * A FILLED check inside a circle — the "this one is selected" mark, as opposed
 * to the bare tick, which reads as "done" rather than "current".
 *
 * Material Symbols geometry, so the viewBox is the 0 -960 960 960 one those
 * ship with rather than the 0 0 24 24 most icons here use.
 */
export const CheckCircleIcon = ({ color = 'currentColor', size = 24, style, className }: { color?: string; size?: number; style?: ViewStyle; className?: string }) => {
  return (
    <IconSvg viewBox="0 -960 960 960" width={size} height={size} style={{ ...style }} className={className}>
      <G>
        <Path fill={color} d="m424-296 282-282-56-56-226 226-114-114-56 56 170 170Zm56 216q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Z"></Path>
      </G>
    </IconSvg>
  );
};
