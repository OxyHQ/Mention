import React from 'react';
import { Path } from 'react-native-svg';
import { IconSvg } from '@/assets/icons/IconSvg';
import { ViewStyle } from 'react-native';

/**
 * Channels — Material Symbols `inbox_text_asterisk`, kept at its own
 * `0 -960 960 960` viewBox rather than re-drawn on the 24-grid the hand-built
 * icons here use. Re-tracing a glyph to match a grid is how an icon quietly
 * stops being the one that was chosen.
 *
 * There is one path, and `Active` renders the same one: this is the FILL0
 * (outline) cut, where the outline IS the filled path, so a heavier variant
 * would have to be invented rather than swapped in. The sidebar already
 * distinguishes the active row by colour — both variants take `currentColor` —
 * so nothing is lost by the pair being identical, and a fabricated "bold" would
 * be worse than an honest repeat.
 */
const CHANNEL_PATH =
  'm744-227-38 53q-9 12-24 14.5t-27-6.5q-12-9-14.5-23.5T647-216l39-53-63-20q-14-5-21-18.5t-2-27.5q5-14 18.5-21t27.5-2l62 21v-66q0-15.3 10.29-25.65Q728.58-439 743.79-439t25.71 10.35Q780-418.3 780-403v66l63-21q14.22-5 27.11 2Q883-349 888-335t-2.5 27.5Q878-294 864-289l-62 20 39 53q9 12 6.5 26.5T833-166q-12 9-27 6.5T782-174l-38-53Zm-528 83q-29 0-50.5-21.5T144-216v-528q0-29.7 21.5-50.85Q187-816 216-816h528q29.7 0 50.85 21.15Q816-773.7 816-744v167q0 15.26-10.29 25.13t-25.5 9.87q-15.21 0-25.71-10.35T744-578v-166H216v312h139q11 0 22.5 5t13.5 16q7 29 24 46.5t40 24.5q11 4 18 13t7 21q0 17.8-14.5 28.4Q451-267 434-272q-38-11-64-34t-41.88-54H216v144h248q15.3 0 25.65 10.29Q500-195.42 500-180.21t-10.35 25.71Q479.3-144 464-144H216Zm0-72h249-1.25H465 216Zm108-396h312q15.3 0 25.65-10.29Q672-632.58 672-647.79t-10.35-25.71Q651.3-684 636-684H324q-15.3 0-25.65 10.29Q288-663.42 288-648.21t10.35 25.71Q308.7-612 324-612Zm0 120h264q15.3 0 25.65-10.29Q624-512.58 624-527.79t-10.35-25.71Q603.3-564 588-564H324q-15.3 0-25.65 10.29Q288-543.42 288-528.21t10.35 25.71Q308.7-492 324-492Z';

interface ChannelIconProps {
  color?: string;
  size?: number;
  style?: ViewStyle;
  className?: string;
}

export const ChannelIcon = ({
  color = 'currentColor',
  size = 26,
  style,
  className,
}: ChannelIconProps) => {
  return (
    <IconSvg
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      style={{ ...style }}
      className={className}
    >
      <Path d={CHANNEL_PATH} fill={color} />
    </IconSvg>
  );
};

export const ChannelIconActive = ({
  color = 'currentColor',
  size = 26,
  style,
  className,
}: ChannelIconProps) => {
  return (
    <IconSvg
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      style={{ ...style }}
      className={className}
    >
      <Path d={CHANNEL_PATH} fill={color} />
    </IconSvg>
  );
};
