/**
 * Font Loading Utilities
 * Optimized font loading using variable fonts to reduce bundle size and loading overhead
 */

/**
 * Font configuration using variable fonts
 * Each variable font file contains all weights, so we only need one file per family
 */
export const FONT_CONFIG = {
  Inter: {
    family: 'Inter',
    variable: require('@/assets/fonts/inter/InterVariable.ttf'),
    // Map weight names to numeric values for variable font
    weights: {
      Thin: '100',
      ExtraLight: '200',
      Light: '300',
      Regular: '400',
      Medium: '500',
      SemiBold: '600',
      Bold: '700',
      ExtraBold: '800',
      Black: '900',
    },
  },
} as const;

/**
 * Generate optimized font map for useFonts
 * Uses single variable font file per family instead of multiple weight files
 */
export function getOptimizedFontMap() {
  const fontMap: Record<string, any> = {};
  
  // Inter font family - single variable font
  fontMap[`${FONT_CONFIG.Inter.family}-Variable`] = FONT_CONFIG.Inter.variable;
  
  // Create aliases for each weight (they all use the same variable font)
  Object.keys(FONT_CONFIG.Inter.weights).forEach((weight) => {
    fontMap[`${FONT_CONFIG.Inter.family}-${weight}`] = FONT_CONFIG.Inter.variable;
  });
  
  return fontMap;
}

/**
 * Get font family name with weight
 * For variable fonts, we use the same family name and set fontWeight in styles
 */
export function getFontFamily(family: 'Inter', weight?: string): string {
  if (weight) {
    return `${family}-${weight}`;
  }
  return `${family}-Regular`;
}

/**
 * Font weight values for use in TextStyle
 */
export const FONT_WEIGHTS = {
  thin: '100',
  extraLight: '200',
  light: '300',
  regular: '400',
  medium: '500',
  semiBold: '600',
  bold: '700',
  extraBold: '800',
  black: '900',
} as const;

