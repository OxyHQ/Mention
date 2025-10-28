import { useMemo } from "react";
import { useColorScheme } from "@/hooks/useColorScheme";
import { useAppearanceStore } from "@/store/appearanceStore";
import { colors as baseColors } from "@/styles/colors";

/**
 * Centralized theme system that provides consistent theming across the app
 * Following Oxy AI Development Instructions for theming
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
 * Main theme hook - use this throughout the app for consistent theming
 * Instead of hardcoded colors, always use theme.colors.xxx
 */
export function useTheme(): Theme {
  const colorScheme = useColorScheme();
  const { mySettings } = useAppearanceStore();
  
  // Get user's custom primary color (if set) or use default
  const customPrimaryColor = mySettings?.appearance?.primaryColor || baseColors.primaryColor;
  
  const isDark = colorScheme === "dark";
  const isLight = colorScheme === "light";
  
  const colors = useMemo<ThemeColors>(() => {
    if (isDark) {
      return {
        // Dark mode colors
        background: baseColors.primaryDark,
        backgroundSecondary: baseColors.primaryDark_1,
        backgroundTertiary: baseColors.primaryDark_2,
        
        text: baseColors.COLOR_BLACK_LIGHT_6,
        textSecondary: baseColors.COLOR_BLACK_LIGHT_5,
        textTertiary: baseColors.COLOR_BLACK_LIGHT_4,
        
        border: baseColors.COLOR_BLACK_LIGHT_3,
        borderLight: baseColors.COLOR_BLACK_LIGHT_2,
        
        primary: customPrimaryColor,
        primaryLight: baseColors.primaryLight_1,
        primaryDark: baseColors.primaryDark,
        
        secondary: baseColors.secondaryColor,
        
        tint: customPrimaryColor,
        icon: baseColors.COLOR_BLACK_LIGHT_5,
        iconActive: customPrimaryColor,
        
        success: "#10B981",
        error: "#EF4444",
        warning: "#F59E0B",
        info: "#3B82F6",
        
        card: baseColors.primaryDark_1,
        shadow: "rgba(0, 0, 0, 0.3)",
        overlay: "rgba(0, 0, 0, 0.5)",
      };
    } else {
      return {
        // Light mode colors
        background: baseColors.COLOR_BLACK_LIGHT_9,
        backgroundSecondary: baseColors.COLOR_BLACK_LIGHT_8,
        backgroundTertiary: baseColors.COLOR_BLACK_LIGHT_7,
        
        text: baseColors.COLOR_BLACK_LIGHT_2,
        textSecondary: baseColors.COLOR_BLACK_LIGHT_4,
        textTertiary: baseColors.COLOR_BLACK_LIGHT_5,
        
        border: baseColors.COLOR_BLACK_LIGHT_6,
        borderLight: baseColors.COLOR_BLACK_LIGHT_7,
        
        primary: customPrimaryColor,
        primaryLight: baseColors.primaryLight_1,
        primaryDark: baseColors.primaryDark,
        
        secondary: baseColors.secondaryColor,
        
        tint: customPrimaryColor,
        icon: baseColors.COLOR_BLACK_LIGHT_4,
        iconActive: customPrimaryColor,
        
        success: "#10B981",
        error: "#EF4444",
        warning: "#F59E0B",
        info: "#3B82F6",
        
        card: baseColors.primaryLight,
        shadow: "rgba(0, 0, 0, 0.1)",
        overlay: "rgba(0, 0, 0, 0.5)",
      };
    }
  }, [isDark, customPrimaryColor]);
  
  return {
    mode: colorScheme,
    colors,
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
