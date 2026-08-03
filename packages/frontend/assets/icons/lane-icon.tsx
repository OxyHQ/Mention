import React from 'react';
import { Path } from 'react-native-svg';
import { IconSvg } from '@/assets/icons/IconSvg';
import { ViewStyle } from 'react-native';

/**
 * Lanes — Material Symbols `schema`, kept at its own `0 -960 960 960` viewBox
 * rather than re-traced onto the 24-grid the hand-built icons use. Re-drawing a
 * glyph to fit a grid is how it stops being the one that was chosen.
 *
 * It replaces a `git-branch`, which said the wrong thing: a branch is a fork —
 * one history splitting into divergent ones. A lane does not divert a post; it
 * is a track a post is filed on, and the post's distribution, visibility,
 * replies and federation are all untouched by it. The parallel rows of `schema`
 * say "tracks side by side", which is what a lane is.
 *
 * There is one path and `Active` renders it too: this is the FILL0 cut, where
 * the outline IS the filled path, so a heavier variant would have to be invented
 * rather than swapped in. The toolbar already tints an active control, which is
 * how every other icon in that row signals its attachment is present.
 */
const LANE_PATH =
  'M152.51-103.72v-92.29q0-29.18 20.66-49.92 20.67-20.74 49.99-20.74h29.35v-93.86h-29.35q-29.32 0-49.99-20.74-20.66-20.74-20.66-49.96v-97.54q0-29.22 20.66-49.96 20.67-20.74 49.99-20.74h29.35v-93.86h-29.35q-29.32 0-49.99-20.74-20.66-20.74-20.66-49.92v-92.29q0-31.56 22.13-53.74 22.13-22.18 53.62-22.18h125.6q31.33 0 53.54 22.18 22.22 22.18 22.22 53.74v92.29q0 29.18-20.74 49.92-20.74 20.74-49.92 20.74h-29.34v93.86h31.74q28.32 0 48.29 19.97 19.97 19.96 19.97 48.29v13.33h140.76v-13.33q0-28.3 19.97-48.28t48.29-19.98h133.1q31.56 0 53.74 22.21 22.17 22.22 22.17 53.54v87.44q0 31.32-22.17 53.54-22.18 22.21-53.74 22.21h-133.1q-28.32 0-48.29-19.97-19.97-19.96-19.97-48.29v-13.33H429.62v13.33q0 28.3-19.97 48.28t-48.29 19.98h-31.74v93.86h29.34q29.18 0 49.92 20.74 20.74 20.74 20.74 49.92v92.29q0 31.56-22.22 53.74-22.21 22.18-53.54 22.18h-125.6q-31.49 0-53.62-22.18t-22.13-53.74Zm75.75 0h125.6v-87.19h-125.6v87.19Zm0-332.56h125.6v-87.44h-125.6v87.44Zm417.88 0h125.6v-87.44h-125.6v87.44ZM228.26-769.25h125.6v-87.03h-125.6v87.03Zm62.92-43.55Zm0 332.8Zm417.88 0ZM291.18-147.2Z';

interface LaneIconProps {
  color?: string;
  size?: number;
  style?: ViewStyle;
  className?: string;
}

export const LaneIcon = ({
  color = 'currentColor',
  size = 26,
  style,
  className,
}: LaneIconProps) => {
  return (
    <IconSvg
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      style={{ ...style }}
      className={className}
    >
      <Path d={LANE_PATH} fill={color} />
    </IconSvg>
  );
};
