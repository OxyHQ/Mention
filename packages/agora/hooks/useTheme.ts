import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

export interface ThemeColors {
  background: string;
  backgroundSecondary: string;
  backgroundTertiary: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  border: string;
  borderLight: string;
  primary: string;
  primaryLight: string;
  primaryDark: string;
  secondary: string;
  tint: string;
  icon: string;
  iconActive: string;
  success: string;
  error: string;
  warning: string;
  info: string;
  card: string;
  shadow: string;
  overlay: string;
  [key: string]: string;
}

export interface Theme {
  mode: 'light' | 'dark';
  colors: ThemeColors;
  isDark: boolean;
  isLight: boolean;
}

const PRIMARY_COLOR = '#FFC107';

export function useTheme(): Theme {
  const colorScheme = useColorScheme() ?? 'light';
  const isDark = colorScheme === 'dark';

  const colors = useMemo<ThemeColors>(() => {
    if (isDark) {
      return {
        background: '#000000',
        backgroundSecondary: '#1C1C1E',
        backgroundTertiary: '#2C2C2E',
        text: '#F2F2F7',
        textSecondary: '#8E8E93',
        textTertiary: '#636366',
        border: '#38383A',
        borderLight: '#2C2C2E',
        primary: PRIMARY_COLOR,
        primaryLight: '#FFD54F',
        primaryDark: '#FFA000',
        onPrimary: '#1C1C1E',
        secondary: '#FF6B35',
        tint: PRIMARY_COLOR,
        icon: '#8E8E93',
        iconActive: PRIMARY_COLOR,
        success: '#10B981',
        error: '#EF4444',
        warning: '#F59E0B',
        info: '#3B82F6',
        card: '#1C1C1E',
        shadow: 'rgba(0, 0, 0, 0.3)',
        overlay: 'rgba(0, 0, 0, 0.5)',
      };
    }
    return {
      background: '#FFFFFF',
      backgroundSecondary: '#F2F2F7',
      backgroundTertiary: '#E5E5EA',
      text: '#1C1C1E',
      textSecondary: '#8E8E93',
      textTertiary: '#AEAEB2',
      border: '#C6C6C8',
      borderLight: '#E5E5EA',
      primary: PRIMARY_COLOR,
      primaryLight: '#FFD54F',
      primaryDark: '#FFA000',
      onPrimary: '#1C1C1E',
      secondary: '#FF6B35',
      tint: PRIMARY_COLOR,
      icon: '#8E8E93',
      iconActive: PRIMARY_COLOR,
      success: '#10B981',
      error: '#EF4444',
      warning: '#F59E0B',
      info: '#3B82F6',
      card: '#FFFFFF',
      shadow: 'rgba(0, 0, 0, 0.1)',
      overlay: 'rgba(0, 0, 0, 0.5)',
    };
  }, [isDark]);

  return {
    mode: colorScheme,
    colors,
    isDark,
    isLight: !isDark,
  };
}
