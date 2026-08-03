import React from 'react';
import { Path } from 'react-native-svg';
import { IconSvg } from '@/assets/icons/IconSvg';
import { ViewStyle } from 'react-native';

/**
 * Schedule — Material Symbols `schedule`, kept at its own `0 -960 960 960`
 * viewBox rather than re-traced onto the 24-grid the hand-built icons use.
 * Re-drawing a glyph to fit a grid is how it stops being the one that was chosen.
 *
 * It also settles an ambiguity that predates it: the schedule control and the
 * EVENT control both drew `CalendarIcon`, so two different actions in the same
 * toolbar row were the same picture. A clock says "when this goes out"; a
 * calendar says "an event is attached". Only the schedule control moves — the
 * event one keeps the calendar, which is now unambiguous by being the only user.
 *
 * Unlike {@link ChannelIcon}, this one HAS a real filled cut (FILL1), so the
 * active state is a different glyph rather than the same one tinted. The two
 * paths differ by exactly the ring's inner edge — outline draws the dial as an
 * annulus and ends with `M480-480Zm0 317.13…`, filled ends at the outer circle.
 */
const SCHEDULE_PATH =
  'M523.59-497.91v-137.31q0-18.52-12.58-31.05Q498.43-678.8 480-678.8t-31.01 12.53q-12.58 12.53-12.58 31.05v153.5q0 9.2 3.36 17.55 3.36 8.36 10.08 15.04l128.17 128.17q12.2 12.2 30.39 12.2 18.2 0 30.63-12.2 12.44-12.19 12.44-30.63 0-18.43-12.44-30.87L523.59-497.91ZM480-71.87q-84.91 0-159.34-32.12-74.44-32.12-129.5-87.17-55.05-55.06-87.17-129.5Q71.87-395.09 71.87-480t32.12-159.34q32.12-74.44 87.17-129.5 55.06-55.05 129.5-87.17 74.43-32.12 159.34-32.12t159.34 32.12q74.44 32.12 129.5 87.17 55.05 55.06 87.17 129.5 32.12 74.43 32.12 159.34t-32.12 159.34q-32.12 74.44-87.17 129.5-55.06 55.05-129.5 87.17Q564.91-71.87 480-71.87ZM480-480Zm0 317.13q131.8 0 224.47-92.54 92.66-92.55 92.66-224.59 0-132.04-92.66-224.59-92.66-92.54-224.47-92.54-131.8 0-224.47 92.54-92.66 92.55-92.66 224.59 0 132.04 92.66 224.59 92.66 92.54 224.47 92.54Z';

const SCHEDULE_FILLED_PATH =
  'M523.59-497.91v-137.31q0-18.52-12.58-31.05Q498.43-678.8 480-678.8t-31.01 12.53q-12.58 12.53-12.58 31.05v153.5q0 9.2 3.36 17.55 3.36 8.36 10.08 15.04l128.17 128.17q12.2 12.2 30.39 12.2 18.2 0 30.63-12.2 12.44-12.19 12.44-30.63 0-18.43-12.44-30.87L523.59-497.91ZM480-71.87q-84.91 0-159.34-32.12-74.44-32.12-129.5-87.17-55.05-55.06-87.17-129.5Q71.87-395.09 71.87-480t32.12-159.34q32.12-74.44 87.17-129.5 55.06-55.05 129.5-87.17 74.43-32.12 159.34-32.12t159.34 32.12q74.44 32.12 129.5 87.17 55.05 55.06 87.17 129.5 32.12 74.43 32.12 159.34t-32.12 159.34q-32.12 74.44-87.17 129.5-55.06 55.05-129.5 87.17Q564.91-71.87 480-71.87Z';

interface ScheduleIconProps {
  color?: string;
  size?: number;
  style?: ViewStyle;
  className?: string;
}

export const ScheduleIcon = ({
  color = 'currentColor',
  size = 26,
  style,
  className,
}: ScheduleIconProps) => {
  return (
    <IconSvg
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      style={{ ...style }}
      className={className}
    >
      <Path d={SCHEDULE_PATH} fill={color} />
    </IconSvg>
  );
};

/** The FILL1 cut — drawn once a time is actually set. */
export const ScheduleIconActive = ({
  color = 'currentColor',
  size = 26,
  style,
  className,
}: ScheduleIconProps) => {
  return (
    <IconSvg
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      style={{ ...style }}
      className={className}
    >
      <Path d={SCHEDULE_FILLED_PATH} fill={color} />
    </IconSvg>
  );
};
