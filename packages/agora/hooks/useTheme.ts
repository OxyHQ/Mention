import { useMemo } from 'react';
import {
  useTheme as useBloomTheme,
  type ThemeColors as BloomThemeColors,
} from '@oxyhq/bloom';

export interface ThemeColors extends BloomThemeColors {
  onPrimary: string;
  [key: string]: string;
}

export interface Theme {
  mode: 'light' | 'dark';
  colors: ThemeColors;
  isDark: boolean;
  isLight: boolean;
}

export function useTheme(): Theme {
  const theme = useBloomTheme();

  return useMemo<Theme>(
    () => ({
      mode: theme.mode,
      colors: { ...theme.colors, onPrimary: theme.colors.primaryForeground },
      isDark: theme.isDark,
      isLight: theme.isLight,
    }),
    [theme],
  );
}
