import React from 'react';
import { ViewStyle } from 'react-native';
import { Path } from 'react-native-svg';
import { IconSvg } from '@/assets/icons/IconSvg';

interface IconProps {
  size?: number;
  color?: string;
  style?: ViewStyle;
  className?: string;
}

// Material Symbols "group_add" (FILL1, wght700). The Material grid uses a 960
// viewBox with a negative y-origin, so keep `viewBox="0 -960 960 960"` verbatim.
export const GroupAddIcon = ({ size = 24, color = 'currentColor', style, className }: IconProps) => (
  <IconSvg width={size} height={size} viewBox="0 -960 960 960" fill="none" style={style} className={className}>
    <Path
      d="M503-505q42-42 61-93.5t19-105.01q0-55.5-22-109Q539-866 501-903q84 14 128 72t44 127q0 72-46 130t-124 69ZM746-86v-163q0-51.77-16.5-91.89Q713-381 680-414q75 14 123.5 56.5T852-249v163H746Zm103-376v-84h-84v-90h84v-84h90v84h83v90h-83v84h-90Zm-690-99q-59-59-59-143.5T159-847q59-58 143.5-58T445-847q58 58 58 142.5T445-561q-58 59-142.5 59T159-561ZM-63-86v-159q0-46 22.69-84.35Q-17.63-367.71 22-387q67-34 137.41-51t142.5-17Q376-455 446-438t135 50q39.63 19.29 62.81 57.15Q667-293 667-245v159H-63Z"
      fill={color}
    />
  </IconSvg>
);
