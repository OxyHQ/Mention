/**
 * Shared Style Patterns
 * Reusable style patterns and utilities to reduce duplication
 */

import { StyleSheet, ViewStyle, TextStyle, ImageStyle, StyleProp } from 'react-native';
import { Theme } from '@/hooks/useTheme';
import { SPACING, COMPONENT_SPACING } from './spacing';

/**
 * Flatten an array of styles into a single style object
 * Moved here to avoid circular dependency
 */
export function flattenStyleArray<T extends ViewStyle | TextStyle | ImageStyle>(
  styles: (StyleProp<T> | undefined | null | false)[]
): StyleProp<T> {
  return StyleSheet.flatten(styles) as StyleProp<T>;
}

/**
 * Convert hex color to rgba string
 */
function hexToRgba(hex: string, opacity: number): string {
  hex = hex.replace('#', '');
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
function convertShadowToBoxShadow(
  color: string,
  offset: { width: number; height: number },
  opacity: number,
  radius: number
): string {
  let rgbaColor: string;
  if (color.startsWith('rgba(')) {
    const rgbaMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/);
    if (rgbaMatch) {
      rgbaColor = `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${opacity})`;
    } else {
      rgbaColor = color;
    }
  } else if (color.startsWith('rgb(')) {
    const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
      rgbaColor = `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${opacity})`;
    } else {
      rgbaColor = color;
    }
  } else {
    rgbaColor = hexToRgba(color, opacity);
  }
  return `${offset.width}px ${offset.height}px ${radius}px 0px ${rgbaColor}`;
}

/**
 * Get themed border style
 */
function getThemedBorder(theme: Theme, width: number = 1): ViewStyle {
  return {
    borderWidth: width,
    borderColor: theme.colors.border,
  };
}

/**
 * Common theme-aware shadows
 */
function getThemedShadow(theme: Theme, elevation: "small" | "medium" | "large" = "medium"): ViewStyle {
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
  return shadows[elevation] as ViewStyle;
}

// Export for use in createThemedContainer
export { getThemedShadow, getThemedBorder };

/**
 * Common border radius values
 */
export const BORDER_RADIUS = {
  /** 4px - Small radius */
  small: 4,
  /** 8px - Medium-small radius */
  medium: 8,
  /** 12px - Standard radius */
  standard: 12,
  /** 16px - Large radius */
  large: 16,
  /** 20px - Button radius */
  button: 20,
  /** 24px - Extra large radius */
  xlarge: 24,
  /** 28px - FAB radius */
  fab: 28,
  /** 100px - Fully rounded (circle) */
  full: 100,
} as const;

/**
 * Common border width values
 */
export const BORDER_WIDTH = {
  /** Hairline border: 0.5px */
  hairline: StyleSheet.hairlineWidth,
  /** Thin border: 1px */
  thin: 1,
  /** Medium border: 2px */
  medium: 2,
  /** Thick border: 3px */
  thick: 3,
} as const;

/**
 * Common opacity values
 */
export const OPACITY = {
  /** Fully transparent */
  transparent: 0,
  /** Almost transparent */
  subtle: 0.1,
  /** Slightly visible */
  light: 0.3,
  /** Half visible */
  medium: 0.5,
  /** Mostly visible */
  heavy: 0.7,
  /** Almost opaque */
  almostOpaque: 0.9,
  /** Fully opaque */
  opaque: 1,
} as const;

/**
 * Elevation/shadow presets
 */
export const ELEVATION = {
  none: 0,
  small: 2,
  medium: 4,
  large: 8,
  xlarge: 16,
} as const;

/**
 * Flex layout presets
 */
export const FLEX = {
  center: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
  },
  rowBetween: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
  },
  rowAround: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-around' as const,
  },
  column: {
    flexDirection: 'column' as const,
  },
  columnCenter: {
    flexDirection: 'column' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  fill: {
    flex: 1,
  },
  wrap: {
    flexWrap: 'wrap' as const,
  },
} as const;

/**
 * Position presets
 */
export const POSITION = {
  absolute: {
    position: 'absolute' as const,
  },
  relative: {
    position: 'relative' as const,
  },
  absoluteFill: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
} as const;

/**
 * Create a themed container style
 */
export function createThemedContainer(theme: Theme, options?: {
  backgroundColor?: keyof Theme['colors'];
  borderRadius?: number;
  padding?: number;
  border?: boolean;
  shadow?: 'small' | 'medium' | 'large';
}): ViewStyle {
  const styles: ViewStyle = {};
  
  if (options?.backgroundColor) {
    styles.backgroundColor = theme.colors[options.backgroundColor];
  }
  
  if (options?.borderRadius !== undefined) {
    styles.borderRadius = options.borderRadius;
  }
  
  if (options?.padding !== undefined) {
    styles.padding = options.padding;
  }
  
  if (options?.border) {
    Object.assign(styles, getThemedBorder(theme));
  }
  
  if (options?.shadow) {
    Object.assign(styles, getThemedShadow(theme, options.shadow));
  }
  
  return styles;
}

/**
 * Create a themed text style
 */
export function createThemedText(theme: Theme, options?: {
  color?: keyof Theme['colors'];
  size?: number;
  weight?: TextStyle['fontWeight'];
}): TextStyle {
  const styles: TextStyle = {};
  
  if (options?.color) {
    styles.color = theme.colors[options.color];
  }
  
  if (options?.size !== undefined) {
    styles.fontSize = options.size;
  }
  
  if (options?.weight) {
    styles.fontWeight = options.weight;
  }
  
  return styles;
}

/**
 * Post item spacing constants (moved from PostItem)
 */
export const POST_ITEM_SPACING = {
  HPAD: COMPONENT_SPACING.post.horizontal,
  VPAD: COMPONENT_SPACING.post.vertical,
  SECTION_GAP: COMPONENT_SPACING.post.sectionGap,
  AVATAR_SIZE: COMPONENT_SPACING.post.avatarSize,
  AVATAR_GAP: COMPONENT_SPACING.post.avatarGap,
  AVATAR_OFFSET: COMPONENT_SPACING.post.avatarOffset,
} as const;

/**
 * Common style patterns
 */
export const COMMON_STYLES = StyleSheet.create({
  /** Full width container */
  fullWidth: {
    width: '100%',
  },
  /** Full height container */
  fullHeight: {
    height: '100%',
  },
  /** Screen container */
  screen: {
    flex: 1,
    width: '100%',
  },
  /** Centered container */
  centered: {
    ...FLEX.center,
  },
  /** Row layout */
  row: {
    ...FLEX.row,
  },
  /** Row with space between */
  rowBetween: {
    ...FLEX.rowBetween,
  },
  /** Absolute fill */
  absoluteFill: {
    ...POSITION.absoluteFill,
  },
  /** Hidden element */
  hidden: {
    display: 'none' as const,
  },
  /** Overflow hidden */
  overflowHidden: {
    overflow: 'hidden' as const,
  },
  /** No overflow */
  overflowVisible: {
    overflow: 'visible' as const,
  },
});

/**
 * Combine multiple style objects into one
 * Utility function for better style composition
 */
export function combineStyles<T extends ViewStyle | TextStyle | ImageStyle>(
  ...styles: Array<T | undefined | null | false>
): T {
  return flattenStyleArray(styles) as T;
}

/**
 * Conditionally apply styles
 */
export function conditionalStyle<T extends ViewStyle | TextStyle | ImageStyle>(
  condition: boolean,
  style: T
): T | null {
  return condition ? style : null;
}

export type BorderRadius = typeof BORDER_RADIUS[keyof typeof BORDER_RADIUS];
export type BorderWidth = typeof BORDER_WIDTH[keyof typeof BORDER_WIDTH];
export type Opacity = typeof OPACITY[keyof typeof OPACITY];
export type Elevation = typeof ELEVATION[keyof typeof ELEVATION];

