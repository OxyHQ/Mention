/**
 * Spacing System
 * Consistent spacing values used throughout the application
 * Based on 4px base unit for scalability
 */

export const SPACING = {
  /** 4px - Extra small spacing */
  xs: 4,
  /** 8px - Small spacing */
  sm: 8,
  /** 12px - Medium-small spacing */
  md: 12,
  /** 16px - Medium spacing (base unit) */
  base: 16,
  /** 20px - Medium-large spacing */
  lg: 20,
  /** 24px - Large spacing */
  xl: 24,
  /** 32px - Extra large spacing */
  '2xl': 32,
  /** 48px - 2x extra large spacing */
  '3xl': 48,
  /** 64px - 3x extra large spacing */
  '4xl': 64,
} as const;

/**
 * Padding presets for common use cases
 */
export const PADDING = {
  /** Minimal padding: 4px */
  minimal: SPACING.xs,
  /** Small padding: 8px */
  small: SPACING.sm,
  /** Medium padding: 12px */
  medium: SPACING.md,
  /** Standard padding: 16px */
  standard: SPACING.base,
  /** Large padding: 24px */
  large: SPACING.xl,
  /** Extra large padding: 32px */
  xlarge: SPACING['2xl'],
  
  // Horizontal/vertical specific
  horizontal: {
    small: SPACING.sm,
    medium: SPACING.md,
    standard: SPACING.base,
    large: SPACING.xl,
  },
  vertical: {
    small: SPACING.sm,
    medium: SPACING.md,
    standard: SPACING.base,
    large: SPACING.xl,
  },
} as const;

/**
 * Gap spacing for flex layouts
 */
export const GAP = {
  /** Small gap: 8px */
  small: SPACING.sm,
  /** Medium gap: 12px */
  medium: SPACING.md,
  /** Standard gap: 16px */
  standard: SPACING.base,
  /** Large gap: 24px */
  large: SPACING.xl,
  /** Extra large gap: 32px */
  xlarge: SPACING['2xl'],
} as const;

/**
 * Margin presets
 */
export const MARGIN = {
  /** Small margin: 8px */
  small: SPACING.sm,
  /** Medium margin: 12px */
  medium: SPACING.md,
  /** Standard margin: 16px */
  standard: SPACING.base,
  /** Large margin: 24px */
  large: SPACING.xl,
  /** Extra large margin: 32px */
  xlarge: SPACING['2xl'],
} as const;

/**
 * Component-specific spacing constants
 */
export const COMPONENT_SPACING = {
  /** Post item spacing - unified spacing for consistent padding/gaps */
  post: {
    /** Horizontal padding: 12px */
    horizontal: SPACING.md,
    /** Vertical padding: 12px */
    vertical: SPACING.md,
    /** Gap between sections: 12px */
    sectionGap: SPACING.md,
    /** Avatar size: 40px */
    avatarSize: 40,
    /** Gap after avatar: 12px */
    avatarGap: SPACING.md,
    /** Avatar offset (horizontal padding + avatar + gap): 64px */
    avatarOffset: SPACING.md + 40 + SPACING.md,
  },
  /** Card spacing */
  card: {
    padding: SPACING.base,
    gap: SPACING.md,
    borderRadius: 16,
  },
  /** Button spacing */
  button: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.base,
    borderRadius: 20,
    gap: SPACING.sm,
  },
  /** Icon button spacing */
  iconButton: {
    size: 40,
    padding: SPACING.sm,
    borderRadius: 100,
  },
  /** Floating action button */
  fab: {
    size: 56,
    borderRadius: 28,
    bottomOffset: SPACING.base,
    rightOffset: SPACING.xl,
  },
} as const;

export type SpacingValue = typeof SPACING[keyof typeof SPACING];
export type PaddingPreset = keyof typeof PADDING;
export type GapPreset = keyof typeof GAP;
export type MarginPreset = keyof typeof MARGIN;

