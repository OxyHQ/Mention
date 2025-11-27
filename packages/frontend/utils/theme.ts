/**
 * Theme utilities for consistent theming across the app
 */

import { StyleSheet, ViewStyle, TextStyle, ImageStyle, StyleProp } from "react-native";
import { Theme } from "@/hooks/useTheme";

/**
 * Convert hex color to rgba string
 */
function hexToRgba(hex: string, opacity: number): string {
  // Remove # if present
  hex = hex.replace('#', '');
  
  // Handle shorthand hex (e.g., #000)
  if (hex.length === 3) {
    hex = hex.split('').map(char => char + char).join('');
  }
  
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Convert shadow props to boxShadow CSS string
 */
export function convertShadowToBoxShadow(
  color: string,
  offset: { width: number; height: number },
  opacity: number,
  radius: number
): string {
  // Convert color to rgba format
  let rgbaColor: string;
  
  if (color.startsWith('rgba(')) {
    // Already rgba, just update opacity
    const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
    if (rgbaMatch) {
      rgbaColor = `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${opacity})`;
    } else {
      rgbaColor = color;
    }
  } else if (color.startsWith('rgb(')) {
    // Convert rgb to rgba
    const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
      rgbaColor = `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${opacity})`;
    } else {
      rgbaColor = color;
    }
  } else {
    // Assume hex color
    rgbaColor = hexToRgba(color, opacity);
  }
  
  return `${offset.width}px ${offset.height}px ${radius}px 0px ${rgbaColor}`;
}

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
      boxShadow: convertShadowToBoxShadow(theme.colors.shadow, { width: 0, height: 1 }, 0.1, 2),
      elevation: 2,
    },
    medium: {
      boxShadow: convertShadowToBoxShadow(theme.colors.shadow, { width: 0, height: 2 }, 0.15, 4),
      elevation: 4,
    },
    large: {
      boxShadow: convertShadowToBoxShadow(theme.colors.shadow, { width: 0, height: 4 }, 0.2, 8),
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
