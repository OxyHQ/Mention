/**
 * Lazy Loading Utilities
 * Helper functions for code splitting and lazy loading components
 */

import { lazy, ComponentType, LazyExoticComponent } from 'react';
import { Suspense, ReactNode } from 'react';
import { Loading } from '@/components/ui/Loading';

/**
 * Type for lazy-loaded components
 */
export type LazyComponent<T extends ComponentType<any>> = LazyExoticComponent<T>;

/**
 * Create a lazy-loaded component with error boundary support
 */
export function createLazyComponent<T extends ComponentType<any>>(
  importFn: () => Promise<{ default: T }>
): LazyExoticComponent<T> {
  return lazy(importFn);
}

/**
 * Lazy loading wrapper with Suspense fallback
 */
interface LazyLoadWrapperProps {
  children: ReactNode;
  fallback?: ReactNode;
  variant?: 'spinner' | 'top' | 'skeleton' | 'inline';
}

export function LazyLoadWrapper({ 
  children, 
  fallback,
  variant = 'spinner',
}: LazyLoadWrapperProps) {
  const defaultFallback = fallback ?? <Loading variant={variant} />;
  
  return (
    <Suspense fallback={defaultFallback}>
      {children}
    </Suspense>
  );
}

/**
 * Create a route component with lazy loading
 */
export function createLazyRoute<T extends ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
  options?: {
    fallback?: ReactNode;
    fallbackVariant?: 'spinner' | 'top' | 'skeleton' | 'inline';
  }
) {
  const LazyComponent = createLazyComponent(importFn);
  
  const LazyRoute = (props: React.ComponentProps<T>) => (
    <LazyLoadWrapper 
      fallback={options?.fallback}
      variant={options?.fallbackVariant}
    >
      <LazyComponent {...props} />
    </LazyLoadWrapper>
  );
  
  return LazyRoute;
}

/**
 * Preload a lazy component (for prefetching)
 */
export async function preloadLazyComponent<T extends ComponentType<any>>(
  lazyComponent: LazyExoticComponent<T>
): Promise<void> {
  // Trigger the import
  await (lazyComponent as any)._payload._result;
}

/**
 * Batch preload multiple lazy components
 */
export async function preloadLazyComponents<T extends ComponentType<any>>(
  lazyComponents: LazyExoticComponent<T>[]
): Promise<void> {
  await Promise.all(lazyComponents.map(preloadLazyComponent));
}

