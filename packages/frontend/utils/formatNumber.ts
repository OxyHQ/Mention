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
 * - 9,999 -> "9.9K"
 * - 1,000,000 -> "1M"
 * - 1,200,000 -> "1.2M"
 * - 1,000,000,000 -> "1B"
 */

/**
 * Truncate to a single decimal place, never rounding up.
 * `toFixed(1)` would render 9,999 as "10.0K" — a threshold the number has not
 * reached — so the displayed value is floored and stays a lower bound.
 */
function truncateToTenth(value: number): number {
  return Math.floor(value * 10) / 10;
}

/**
 * Format a number with compact notation (Twitter-style)
 * Optimized for performance - single pass, minimal allocations
 * Shows one decimal whenever the value is not a whole multiple of the unit
 * (1,500 -> "1.5K"); whole multiples stay bare (10,000 -> "10K")
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
    return `${sign}${truncateToTenth(absNum / 1000000000)}B`;
  }

  // Millions (>= 1M)
  if (absNum >= 1000000) {
    return `${sign}${truncateToTenth(absNum / 1000000)}M`;
  }

  // Thousands (>= 1K)
  if (absNum >= 1000) {
    return `${sign}${truncateToTenth(absNum / 1000)}K`;
  }

  // Less than 1000, return as-is
  return `${sign}${Math.floor(absNum)}`;
}

/**
 * Format engagement numbers (likes, boosts, followers, etc.)
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

