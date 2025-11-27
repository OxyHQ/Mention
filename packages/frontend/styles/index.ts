/**
 * Styles Barrel Export
 * Centralized exports for all style utilities and constants
 * This file avoids circular dependencies by importing from base modules
 */

// Spacing constants
export {
  SPACING,
  PADDING,
  GAP,
  MARGIN,
  COMPONENT_SPACING,
  POST_ITEM_SPACING,
  type SpacingValue,
  type PaddingPreset,
  type GapPreset,
  type MarginPreset,
} from './spacing';

// Typography constants and utilities
export {
  FONT_SIZES,
  FONT_WEIGHTS,
  FONT_FAMILIES,
  LINE_HEIGHTS,
  LETTER_SPACING,
  TYPOGRAPHY,
  getTypographyStyle,
  createTypographyStyle,
  type TypographyPreset,
  type FontSize,
  type FontWeight,
  type TypographyPresetName,
} from './typography';

// Shared style patterns and utilities
export {
  BORDER_RADIUS,
  BORDER_WIDTH,
  OPACITY,
  ELEVATION,
  FLEX,
  POSITION,
  COMMON_STYLES,
  createThemedContainer,
  createThemedText,
  combineStyles,
  conditionalStyle,
  flattenStyleArray,
  getThemedShadow,
  getThemedBorder,
  type BorderRadius,
  type BorderWidth,
  type Opacity,
  type Elevation,
} from './shared';

