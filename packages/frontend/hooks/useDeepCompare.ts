import { useMemo, useRef } from 'react';
import { depsShallowEqual } from '@/utils/feedUtils';

/**
 * Dependency-list comparison memo hook.
 *
 * Recomputes the value only when the dependency list changes by
 * {@link depsShallowEqual} (one level, `Object.is` each) — replacing the
 * old `JSON.stringify` deep compare that ran on every render of the feed.
 */
export function useDeepCompareMemo<T>(factory: () => T, dependencies: React.DependencyList): T {
  const ref = useRef(0);
  const prevDeps = useRef<React.DependencyList>(dependencies);

  if (!depsShallowEqual(prevDeps.current, dependencies)) {
    ref.current += 1;
    prevDeps.current = dependencies;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependencies are deep-compared into ref.current by design.
  return useMemo(factory, [ref.current]);
}
