/**
 * Performance Utilities
 * Shared performance optimization utilities
 */

/**
 * Request Animation Frame wrapper for smooth animations
 */
export function raf(callback: () => void): number {
  if (typeof requestAnimationFrame !== 'undefined') {
    return requestAnimationFrame(callback);
  }
  return setTimeout(callback, 16) as unknown as number;
}

/**
 * Cancel Animation Frame wrapper
 */
export function cancelRaf(id: number): void {
  if (typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(id);
  } else {
    clearTimeout(id);
  }
}

/**
 * Batch multiple state updates together
 * Useful for preventing multiple re-renders
 */
export function batchUpdates(updates: (() => void)[]): void {
  updates.forEach((update) => update());
}

/**
 * Check if code is running in production
 */
export const isProduction = process.env.NODE_ENV === 'production';

/**
 * Performance logger (only in development)
 */
export const perfLog = isProduction
  ? () => {}
  : (label: string, fn: () => void) => {
      const start = performance.now();
      fn();
      const end = performance.now();
      console.log(`[Perf] ${label}: ${(end - start).toFixed(2)}ms`);
    };

/**
 * Memoize expensive computations
 */
export function memoize<Args extends any[], Return>(
  fn: (...args: Args) => Return,
  keyFn?: (...args: Args) => string
): (...args: Args) => Return {
  const cache = new Map<string, Return>();

  return (...args: Args): Return => {
    const key = keyFn ? keyFn(...args) : JSON.stringify(args);
    if (cache.has(key)) {
      return cache.get(key)!;
    }
    const result = fn(...args);
    cache.set(key, result);
    return result;
  };
}

