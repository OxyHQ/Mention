/**
 * Theme utilities for consistent theming across the app
 * Use these utilities instead of hardcoded color values
 */

import { StyleSheet, ViewStyle, TextStyle, ImageStyle } from "react-native";
import { Theme } from "@/hooks/useTheme";

/**
 * Flatten an array of styles into a single style object
 * Handles arrays, objects, and undefined/null values
 */
export function flattenStyleArray(
  styles: (ViewStyle | TextStyle | ImageStyle | undefined | null | false)[]
): ViewStyle | TextStyle | ImageStyle | undefined {
  const validStyles = styles.filter((style): style is ViewStyle | TextStyle | ImageStyle => {
    return style !== null && style !== undefined && style !== false;
  });
  
  if (validStyles.length === 0) {
    return undefined;
  }
  
  if (validStyles.length === 1) {
    return validStyles[0];
  }
  
  return StyleSheet.flatten(validStyles);
}

/**
 * Create themed styles - use this for StyleSheet.create with theme-aware colors
 * 
 * Example usage:
 * const styles = createThemedStyles((theme) => ({
 *   container: {
 *     backgroundColor: theme.colors.background,
 *     borderColor: theme.colors.border,
 *   },
 *   text: {
 *     color: theme.colors.text,
 *   }
 * }));
 * 
 * Then in component: const themedStyles = styles(theme);
 */
export function createThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  stylesFn: (theme: Theme) => T
) {
  return (theme: Theme) => StyleSheet.create(stylesFn(theme));
}

/**
 * Get opacity variant of a color
 */
export function withOpacity(color: string, opacity: number): string {
  // Convert hex to rgba
  const hex = color.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Get a lighter or darker shade of a color
 */
export function adjustBrightness(color: string, amount: number): string {
  const hex = color.replace("#", "");
  const r = Math.min(255, Math.max(0, parseInt(hex.substring(0, 2), 16) + amount));
  const g = Math.min(255, Math.max(0, parseInt(hex.substring(2, 4), 16) + amount));
  const b = Math.min(255, Math.max(0, parseInt(hex.substring(4, 6), 16) + amount));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
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

/**
 * Get themed card style
 */
export function getThemedCard(theme: Theme) {
  return {
    backgroundColor: theme.colors.card,
    borderRadius: 12,
    ...getThemedShadow(theme, "small"),
  };
}
