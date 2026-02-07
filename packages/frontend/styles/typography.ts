/**
 * Typography System
 * Consistent typography scales and font configurations
 */

import { Platform, TextStyle } from 'react-native';

/**
 * Font families
 */
export const FONT_FAMILIES = {
  /** Primary font - Inter Variable */
  primary: 'Inter-Regular',
} as const;

/**
 * Font weights
 */
export const FONT_WEIGHTS = {
  thin: '100' as const,
  extraLight: '200' as const,
  light: '300' as const,
  regular: '400' as const,
  medium: '500' as const,
  semiBold: '600' as const,
  bold: '700' as const,
  extraBold: '800' as const,
  black: '900' as const,
} as const;

/**
 * Font size scale (based on 16px base)
 */
export const FONT_SIZES = {
  /** 10px - Tiny text */
  xs: 10,
  /** 12px - Small text */
  sm: 12,
  /** 14px - Body small */
  base: 14,
  /** 15px - Body medium */
  md: 15,
  /** 16px - Body large (base) */
  lg: 16,
  /** 18px - Heading small */
  xl: 18,
  /** 20px - Heading medium */
  '2xl': 20,
  /** 24px - Heading large */
  '3xl': 24,
  /** 30px - Display small */
  '4xl': 30,
  /** 36px - Display medium */
  '5xl': 36,
  /** 48px - Display large */
  '6xl': 48,
} as const;

/**
 * Line height scale (multiplier of font size)
 */
export const LINE_HEIGHTS = {
  /** Tight line height (1.2x) */
  tight: 1.2,
  /** Normal line height (1.5x) */
  normal: 1.5,
  /** Relaxed line height (1.75x) */
  relaxed: 1.75,
  /** Loose line height (2x) */
  loose: 2,
} as const;

/**
 * Letter spacing scale
 */
export const LETTER_SPACING = {
  /** Tighter spacing: -0.5px */
  tighter: -0.5,
  /** Tight spacing: -0.25px */
  tight: -0.25,
  /** Normal spacing: 0px */
  normal: 0,
  /** Wide spacing: 0.25px */
  wide: 0.25,
  /** Wider spacing: 0.5px */
  wider: 0.5,
} as const;

/**
 * Typography presets for common text styles
 */
export interface TypographyPreset {
  fontFamily: string;
  fontSize: number;
  fontWeight: TextStyle['fontWeight'];
  lineHeight?: number;
  letterSpacing?: number;
}

export const TYPOGRAPHY: Record<string, TypographyPreset> = {
  /** Display large - for hero text */
  displayLarge: {
    fontFamily: FONT_FAMILIES.primary,
    fontSize: FONT_SIZES['6xl'],
    fontWeight: Platform.OS === 'web' ? FONT_WEIGHTS.bold : '700',
    lineHeight: FONT_SIZES['6xl'] * LINE_HEIGHTS.tight,
    letterSpacing: LETTER_SPACING.tight,
  },
  /** Display medium - for large headings */
  displayMedium: {
    fontFamily: FONT_FAMILIES.primary,
    fontSize: FONT_SIZES['5xl'],
    fontWeight: Platform.OS === 'web' ? FONT_WEIGHTS.bold : '700',
    lineHeight: FONT_SIZES['5xl'] * LINE_HEIGHTS.tight,
    letterSpacing: LETTER_SPACING.tight,
  },
  /** Heading 1 - main page headings */
  h1: {
    fontFamily: FONT_FAMILIES.primary,
    fontSize: FONT_SIZES['3xl'],
    fontWeight: Platform.OS === 'web' ? FONT_WEIGHTS.bold : '700',
    lineHeight: FONT_SIZES['3xl'] * LINE_HEIGHTS.tight,
    letterSpacing: LETTER_SPACING.normal,
  },
  /** Heading 2 - section headings */
  h2: {
    fontFamily: FONT_FAMILIES.primary,
    fontSize: FONT_SIZES['2xl'],
    fontWeight: Platform.OS === 'web' ? FONT_WEIGHTS.bold : '700',
    lineHeight: FONT_SIZES['2xl'] * LINE_HEIGHTS.normal,
    letterSpacing: LETTER_SPACING.normal,
  },
  /** Heading 3 - subsection headings */
  h3: {
    fontFamily: FONT_FAMILIES.primary,
    fontSize: FONT_SIZES.xl,
    fontWeight: Platform.OS === 'web' ? FONT_WEIGHTS.bold : '600',
    lineHeight: FONT_SIZES.xl * LINE_HEIGHTS.normal,
    letterSpacing: LETTER_SPACING.normal,
  },
  /** Body large - primary body text */
  bodyLarge: {
    fontFamily: FONT_FAMILIES.primary,
    fontSize: FONT_SIZES.lg,
    fontWeight: FONT_WEIGHTS.regular,
    lineHeight: FONT_SIZES.lg * LINE_HEIGHTS.normal,
    letterSpacing: LETTER_SPACING.normal,
  },
  /** Body medium - standard body text */
  bodyMedium: {
    fontFamily: FONT_FAMILIES.primary,
    fontSize: FONT_SIZES.md,
    fontWeight: FONT_WEIGHTS.regular,
    lineHeight: FONT_SIZES.md * LINE_HEIGHTS.normal,
    letterSpacing: LETTER_SPACING.normal,
  },
  /** Body small - secondary text */
  bodySmall: {
    fontFamily: FONT_FAMILIES.primary,
    fontSize: FONT_SIZES.base,
    fontWeight: FONT_WEIGHTS.regular,
    lineHeight: FONT_SIZES.base * LINE_HEIGHTS.normal,
    letterSpacing: LETTER_SPACING.normal,
  },
  /** Caption - small helper text */
  caption: {
    fontFamily: FONT_FAMILIES.primary,
    fontSize: FONT_SIZES.sm,
    fontWeight: FONT_WEIGHTS.regular,
    lineHeight: FONT_SIZES.sm * LINE_HEIGHTS.normal,
    letterSpacing: LETTER_SPACING.wide,
  },
  /** Button text */
  button: {
    fontFamily: FONT_FAMILIES.primary,
    fontSize: FONT_SIZES.md,
    fontWeight: Platform.OS === 'web' ? FONT_WEIGHTS.bold : '600',
    lineHeight: FONT_SIZES.md * LINE_HEIGHTS.tight,
    letterSpacing: LETTER_SPACING.normal,
  },
  /** Link text */
  link: {
    fontFamily: FONT_FAMILIES.primary,
    fontSize: FONT_SIZES.md,
    fontWeight: FONT_WEIGHTS.medium,
    lineHeight: FONT_SIZES.md * LINE_HEIGHTS.normal,
    letterSpacing: LETTER_SPACING.normal,
  },
} as const;

/**
 * Get typography style by preset name
 */
export function getTypographyStyle(preset: keyof typeof TYPOGRAPHY): TextStyle {
  return TYPOGRAPHY[preset];
}

/**
 * Create custom typography style
 */
export function createTypographyStyle(
  fontSize: number,
  fontWeight: TextStyle['fontWeight'] = FONT_WEIGHTS.regular,
  options?: {
    fontFamily?: string;
    lineHeight?: number;
    letterSpacing?: number;
  }
): TextStyle {
  return {
    fontFamily: options?.fontFamily ?? FONT_FAMILIES.primary,
    fontSize,
    fontWeight,
    lineHeight: options?.lineHeight ?? fontSize * LINE_HEIGHTS.normal,
    letterSpacing: options?.letterSpacing ?? LETTER_SPACING.normal,
  };
}

export type FontSize = typeof FONT_SIZES[keyof typeof FONT_SIZES];
export type FontWeight = typeof FONT_WEIGHTS[keyof typeof FONT_WEIGHTS];
export type TypographyPresetName = keyof typeof TYPOGRAPHY;

