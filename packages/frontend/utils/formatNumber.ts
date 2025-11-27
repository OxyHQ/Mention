/**
 * Format number with K, M, B suffixes (Twitter-style)
 * Optimized and efficient number formatting utility
 * 
 * Examples:
 * - 999 -> "999"
 * - 1,000 -> "1K"
 * - 1,500 -> "1.5K"
 * - 10,000 -> "10K"
 * - 12,500 -> "12.5K"
 * - 1,000,000 -> "1M"
 * - 1,200,000 -> "1.2M"
 * - 1,000,000,000 -> "1B"
 */

/**
 * Format a number with compact notation (Twitter-style)
 * Optimized for performance - single pass, minimal allocations
 * Shows decimals only when needed for clarity (>= 10K for K, >= 1M for M)
 * 
 * @param num - The number to format
 * @returns Formatted string (e.g., "1.2K", "5M", "1B")
 */
export function formatCompactNumber(num: number): string {
  // Fast path: invalid input
  if (typeof num !== 'number' || !isFinite(num)) {
    return '0';
  }

  // Fast path: zero
  if (num === 0) {
    return '0';
  }

  const absNum = Math.abs(num);
  const sign = num < 0 ? '-' : '';

  // Billions (>= 1B)
  if (absNum >= 1000000000) {
    const billions = absNum / 1000000000;
    // Show decimal if not a round number (e.g., 1.2B, not 1B)
    if (billions % 1 !== 0 && billions < 10) {
      return `${sign}${billions.toFixed(1)}B`;
    }
    return `${sign}${Math.floor(billions)}B`;
  }

  // Millions (>= 1M)
  if (absNum >= 1000000) {
    const millions = absNum / 1000000;
    // Show decimal if not a round number (e.g., 1.2M, not 1M)
    if (millions % 1 !== 0 && millions < 10) {
      return `${sign}${millions.toFixed(1)}M`;
    }
    return `${sign}${Math.floor(millions)}M`;
  }

  // Thousands (>= 1K)
  if (absNum >= 1000) {
    const thousands = absNum / 1000;
    // Show decimal only if >= 10K and not a round number (e.g., 12.5K, but 10K not 10.0K)
    if (absNum >= 10000 && thousands % 1 !== 0) {
      return `${sign}${thousands.toFixed(1)}K`;
    }
    return `${sign}${Math.floor(thousands)}K`;
  }

  // Less than 1000, return as-is
  return `${sign}${Math.floor(absNum)}`;
}

/**
 * Format engagement numbers (likes, reposts, followers, etc.)
 * Alias for formatCompactNumber - optimized for social media display
 */
export function formatEngagement(num: number): string {
  return formatCompactNumber(num);
}

/**
 * Format a number with K, M, B suffixes (advanced version with options)
 * Use formatCompactNumber for most cases - this is for custom formatting needs
 * 
 * @param num - The number to format
 * @param options - Formatting options
 * @returns Formatted string (e.g., "1.2K", "5M")
 */
export function formatNumber(
  num: number,
  options: {
    /** Minimum value to show decimal (default: 10000 for K, 1000000 for M) */
    showDecimalThreshold?: number;
    /** Number of decimal places (default: 1) */
    decimals?: number;
    /** Show decimal for round numbers (default: false) */
    showDecimalForRound?: boolean;
  } = {}
): string {
  // Fast path: invalid input
  if (typeof num !== 'number' || !isFinite(num)) {
    return '0';
  }

  const {
    showDecimalThreshold = 10000,
    decimals = 1,
    showDecimalForRound = false,
  } = options;

  const absNum = Math.abs(num);
  const sign = num < 0 ? '-' : '';

  // Billions
  if (absNum >= 1000000000) {
    const billions = absNum / 1000000000;
    const shouldShowDecimal = absNum >= showDecimalThreshold * 1000 || showDecimalForRound;
    if (shouldShowDecimal && billions % 1 !== 0) {
      return `${sign}${billions.toFixed(decimals)}B`;
    }
    return `${sign}${Math.floor(billions)}B`;
  }

  // Millions
  if (absNum >= 1000000) {
    const millions = absNum / 1000000;
    const shouldShowDecimal = absNum >= showDecimalThreshold || showDecimalForRound;
    if (shouldShowDecimal && millions % 1 !== 0) {
      return `${sign}${millions.toFixed(decimals)}M`;
    }
    return `${sign}${Math.floor(millions)}M`;
  }

  // Thousands
  if (absNum >= 1000) {
    const thousands = absNum / 1000;
    const shouldShowDecimal = absNum >= showDecimalThreshold || showDecimalForRound;
    if (shouldShowDecimal && thousands % 1 !== 0) {
      return `${sign}${thousands.toFixed(decimals)}K`;
    }
    return `${sign}${Math.floor(thousands)}K`;
  }

  // Less than 1000
  return `${sign}${Math.floor(absNum)}`;
}

