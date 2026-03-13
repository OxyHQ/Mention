import { useMemo } from "react";
import { Platform } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { getAdaptiveColors } from "@/styles/adaptiveColors";

/**
 * Bridge layer: keeps the same ThemeColors/Theme interface so all 170+ consumers
 * continue working, but now reads from the NativeWind CSS-variable system.
 */

export interface ThemeColors {
  // Background colors
  background: string;
  backgroundSecondary: string;
  backgroundTertiary: string;

  // Text colors
  text: string;
  textSecondary: string;
  textTertiary: string;

  // Border colors
  border: string;
  borderLight: string;

  // Primary brand colors
  primary: string;
  primaryLight: string;
  primaryDark: string;

  // Secondary/Oxy brand color
  secondary: string;

  // Interactive colors
  tint: string;
  icon: string;
  iconActive: string;

  // Status colors
  success: string;
  error: string;
  warning: string;
  info: string;

  // Component-specific
  card: string;
  shadow: string;
  overlay: string;
}

export interface Theme {
  mode: "light" | "dark";
  colors: ThemeColors;
  isDark: boolean;
  isLight: boolean;
}

/**
 * Main theme hook - use this throughout the app for consistent theming.
 * Now backed by NativeWind CSS variables via lib/useColorScheme.
 */
export function useTheme(): Theme {
  const { colorScheme, isDarkColorScheme, colors, isAdaptive } = useColorScheme();

  const isDark = isDarkColorScheme;
  const isLight = !isDarkColorScheme;

  const themeColors = useMemo<ThemeColors>(() => {
    // Adaptive mode on native: use platform-native colors
    if (isAdaptive && Platform.OS !== 'web') {
      const adaptive = getAdaptiveColors();
      if (adaptive) return adaptive;
    }

    return {
      background: colors.background,
      backgroundSecondary: colors.surface,
      backgroundTertiary: colors.muted,

      text: colors.foreground,
      textSecondary: colors.mutedForeground,
      textTertiary: colors.mutedForeground,

      border: colors.border,
      borderLight: colors.input,

      primary: colors.primary,
      primaryLight: colors.surface,
      primaryDark: colors.background,

      secondary: colors.primary,

      tint: colors.primary,
      icon: colors.mutedForeground,
      iconActive: colors.primary,

      success: "#10B981",
      error: "#EF4444",
      warning: "#F59E0B",
      info: "#3B82F6",

      card: colors.surface,
      shadow: isDark ? "rgba(0, 0, 0, 0.3)" : "rgba(0, 0, 0, 0.1)",
      overlay: "rgba(0, 0, 0, 0.5)",
    };
  }, [colors, isDark, isAdaptive]);

  return {
    mode: colorScheme,
    colors: themeColors,
    isDark,
    isLight,
  };
}

/**
 * Helper hook to get a specific color from the theme
 * Usage: const bgColor = useThemeColor('background')
 */
export function useThemeColor(colorKey: keyof ThemeColors): string {
  const theme = useTheme();
  return theme.colors[colorKey];
}
