/**
 * Theme utilities for consistent theming across the app
 */

import { StyleSheet, ViewStyle, TextStyle, ImageStyle, StyleProp } from "react-native";
import { Theme } from "@/hooks/useTheme";

/**
 * Flatten an array of styles into a single style object
 */
export function flattenStyleArray<T extends ViewStyle | TextStyle | ImageStyle>(
  styles: (StyleProp<T> | undefined | null | false)[]
): StyleProp<T> {
  return StyleSheet.flatten(styles) as StyleProp<T>;
}

/**
 * Common theme-aware shadows
 */
export function getThemedShadow(theme: Theme, elevation: "small" | "medium" | "large" = "medium") {
  const shadows = {
    small: {
      shadowColor: theme.colors.shadow,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.1,
      shadowRadius: 2,
      elevation: 2,
    },
    medium: {
      shadowColor: theme.colors.shadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.15,
      shadowRadius: 4,
      elevation: 4,
    },
    large: {
      shadowColor: theme.colors.shadow,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 8,
      elevation: 8,
    },
  };
  return shadows[elevation];
}

/**
 * Get themed border style
 */
export function getThemedBorder(theme: Theme, width: number = 1) {
  return {
    borderWidth: width,
    borderColor: theme.colors.border,
  };
}
