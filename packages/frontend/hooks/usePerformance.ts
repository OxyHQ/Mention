/**
 * Performance Hooks
 * Common performance optimization patterns used throughout the app
 */

import { useCallback, useMemo, useRef } from 'react';

/**
 * Debounce hook for expensive operations
 * Prevents function calls until delay has passed since last call
 */
export function useDebounce<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): T {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    ((...args: Parameters<T>) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        callback(...args);
      }, delay);
    }) as T,
    [callback, delay]
  );
}

/**
 * Throttle hook for frequent events
 * Limits function calls to once per delay period
 */
export function useThrottle<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): T {
  const lastRunRef = useRef<number>(0);

  return useCallback(
    ((...args: Parameters<T>) => {
      const now = Date.now();
      if (now - lastRunRef.current >= delay) {
        lastRunRef.current = now;
        callback(...args);
      }
    }) as T,
    [callback, delay]
  );
}

/**
 * Stable reference hook
 * Returns a stable reference that only changes when dependencies change
 */
export function useStableRef<T>(value: T, deps: React.DependencyList): T {
  return useMemo(() => value, deps);
}

/**
 * Memoized callback that only changes when dependencies change
 * Similar to useCallback but with better type inference
 */
export function useStableCallback<T extends (...args: any[]) => any>(
  callback: T,
  deps: React.DependencyList
): T {
  return useCallback(callback, deps);
}

