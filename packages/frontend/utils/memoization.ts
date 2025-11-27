/**
 * Memoization Utilities
 * Helper functions for optimizing component re-renders
 */

import { memo, ComponentType, useMemo, useCallback, DependencyList } from 'react';

/**
 * Type for comparing props in React.memo
 */
export type CompareFunction<T> = (prevProps: T, nextProps: T) => boolean;

/**
 * Shallow comparison function for props
 * Compares all keys at first level only
 */
export function shallowEqual<T extends Record<string, any>>(
  prevProps: T,
  nextProps: T
): boolean {
  const prevKeys = Object.keys(prevProps);
  const nextKeys = Object.keys(nextProps);
  
  if (prevKeys.length !== nextKeys.length) {
    return false;
  }
  
  for (const key of prevKeys) {
    if (prevProps[key] !== nextProps[key]) {
      return false;
    }
  }
  
  return true;
}

/**
 * Deep comparison function for props
 * Recursively compares nested objects
 */
export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  
  if (a == null || b == null) return false;
  
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  
  if (keysA.length !== keysB.length) return false;
  
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  
  return true;
}

/**
 * Create a memoized component with custom comparison
 */
export function memoWithCompare<T extends ComponentType<any>>(
  Component: T,
  compare?: CompareFunction<React.ComponentProps<T>>
): T {
  if (compare) {
    return memo(Component, compare) as T;
  }
  return memo(Component) as T;
}

/**
 * Create a memoized component with shallow comparison
 */
export function memoShallow<T extends ComponentType<any>>(
  Component: T
): T {
  return memo(Component, shallowEqual) as T;
}

/**
 * Create a memoized component with deep comparison
 * Use sparingly - deep comparison can be expensive
 */
export function memoDeep<T extends ComponentType<any>>(
  Component: T
): T {
  return memo(Component, deepEqual) as T;
}

/**
 * Stable memo hook - returns memoized value that only changes when deps change
 * Useful for preventing unnecessary re-renders when passing objects/arrays as props
 */
export function useStableMemo<T>(
  factory: () => T,
  deps: DependencyList
): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(factory, deps);
}

/**
 * Stable callback hook - returns memoized callback that only changes when deps change
 * More explicit than useCallback for stable function references
 */
export function useStableCallback<T extends (...args: any[]) => any>(
  callback: T,
  deps: DependencyList
): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback(callback, deps);
}

/**
 * Compare props by specific keys only
 * Useful when component should only re-render when certain props change
 */
export function createCompareByKeys<T extends Record<string, any>>(
  keys: Array<keyof T>
): CompareFunction<T> {
  return (prevProps: T, nextProps: T) => {
    for (const key of keys) {
      if (prevProps[key] !== nextProps[key]) {
        return false;
      }
    }
    return true;
  };
}

/**
 * Compare props ignoring specific keys
 * Useful when some props should be ignored for comparison
 */
export function createCompareIgnoreKeys<T extends Record<string, any>>(
  ignoreKeys: Array<keyof T>
): CompareFunction<T> {
  return (prevProps: T, nextProps: T) => {
    const prevKeys = Object.keys(prevProps) as Array<keyof T>;
    const nextKeys = Object.keys(nextProps) as Array<keyof T>;
    
    if (prevKeys.length !== nextKeys.length) {
      return false;
    }
    
    for (const key of prevKeys) {
      if (ignoreKeys.includes(key)) continue;
      if (prevProps[key] !== nextProps[key]) {
        return false;
      }
    }
    
    return true;
  };
}

/**
 * Compare function for components with ID-based props
 * Assumes props have an 'id' field and only compares that + other specified keys
 */
export function compareById<T extends { id?: string | number }>(
  prevProps: T,
  nextProps: T
): boolean {
  if (prevProps.id !== nextProps.id) {
    return false;
  }
  return shallowEqual(prevProps, nextProps);
}

/**
 * Create a memoized component that only re-renders when ID changes
 */
export function memoById<T extends ComponentType<any>>(Component: T): T {
  return memo(Component, compareById) as T;
}

