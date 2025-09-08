/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { colors } from '@/styles/colors';

const tintColorLight = colors.primaryColor;
const tintColorDark = colors.primaryColor;

export const Colors = {
  light: {
  text: colors.COLOR_BLACK_LIGHT_2,
  background: colors.COLOR_BLACK_LIGHT_9,
    tint: tintColorLight,
  icon: colors.COLOR_BLACK_LIGHT_4,
  tabIconDefault: colors.COLOR_BLACK_LIGHT_4,
    tabIconSelected: tintColorLight,
  },
  dark: {
  text: colors.COLOR_BLACK_LIGHT_6,
  background: colors.primaryDark,
    tint: tintColorDark,
  icon: colors.COLOR_BLACK_LIGHT_5,
  tabIconDefault: colors.COLOR_BLACK_LIGHT_5,
    tabIconSelected: tintColorDark,
  },
};
