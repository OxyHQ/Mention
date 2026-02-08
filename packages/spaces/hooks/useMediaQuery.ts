import { useMemo } from 'react';
import { useMediaQuery } from 'react-responsive';

export function useOptimizedMediaQuery(query: { minWidth?: number; maxWidth?: number }) {
  const stableQuery = useMemo(() => query, [query.minWidth, query.maxWidth]);
  return useMediaQuery(stableQuery);
}

export function useIsScreenNotMobile() {
  return useOptimizedMediaQuery({ minWidth: 500 });
}

export function useIsDesktop() {
  return useOptimizedMediaQuery({ minWidth: 1024 });
}
