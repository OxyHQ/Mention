import React from 'react';
import Svg, { Path, G } from 'react-native-svg';
import { useTheme } from '@oxyhq/bloom/theme';

// Original Material Symbols path in viewBox "0 -960 960 960".
// Translated +960 on Y axis to fit viewBox "0 0 960 960".
const ICON_PATH =
  'M372 859q-46 0-80-29t-45-73q-11 20-31.5 30.5T172 798q-39 0-66.5-27.5T78 704q0-35 25-64t63-28q-22-18-35-45t-13-56q0-31 15-58.5t42-45.5q2 6 5.5 13l6.5 13q-20 15-30 35.5T147 512q0 64 46 83.5t97 29.5l6 11q-11 32-17.5 54t-6.5 41q0 40 29 69.5t70 29.5q44 0 72-31.5t46-75q18-43.5 28-90t17-77.5l28 8q-8 38-19 89t-31.5 96.5Q491 795 458 827t-86 32Zm31-256q-39-35-71.5-65.5t-56-60Q252 448 239 418.5T226 357q0-54 37-91t91-37q13 0 23.5 1.5T397 235q-5-9-8-18.5t-3-20.5q0-39 27.5-66.5T480 102q39 0 66.5 27.5T574 196q0 11-3 20.5t-8 18.5q9-3 19.5-4.5T606 229q41 0 72.5 22t45.5 57q-7-1-15.5-1t-15.5 1q-12-23-35-37t-52-14q-38 0-61 19t-59 61h-13q-37-43-60-61.5T354 257q-43 0-71.5 28.5T254 357q0 23 11.5 48t33.5 52.5q22 27.5 53 58.5t71 67l-20 20Zm182 257q-12 0-23.5-2t-22.5-7q4-5 8-12t7-13q8 3 16.5 4t16.5 1q41 0 70.5-29.5T687 731q0-19-6.5-40.5T663 637l7-11q52-10 97.5-30t45.5-84q0-51-35.5-76T697 411q-40 0-93 13t-122 36l-8-28q66-21 119-36t98-15q58 0 104 34t46 97q0 29-12.5 54.5T794 612q38 0 63 28t25 64q0 38-27.5 66T788 798q-23 0-43.5-10.5T713 757q-11 44-46 73.5T585 860Z';

interface MentionAvatarIconProps {
  size: number;
}

export function MentionAvatarIcon({ size }: MentionAvatarIconProps) {
  const theme = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 960 960">
      <Path d={ICON_PATH} fill={theme.colors.primary} />
    </Svg>
  );
}
