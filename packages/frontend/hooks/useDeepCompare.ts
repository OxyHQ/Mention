import { useEffect, useRef, useMemo } from 'react';
import { depsShallowEqual } from '@/utils/feedUtils';

/**
 * Dependency-list comparison hook for useEffect.
 *
 * Triggers the effect only when the dependency list changes by
 * {@link depsShallowEqual}: large arrays (feed `items`/`slices`) and the privacy
 * `blockedSet` Set are compared by reference, primitives by `===`, and plain
 * objects (e.g. `filters`) by one shallow pass — so a rebuilt-but-equal filters
 * object never re-fires while any real change always does. This avoids
 * `JSON.stringify`-based comparison on every render.
 */
export function useDeepCompareEffect(
    callback: React.EffectCallback,
    dependencies: React.DependencyList
) {
    const ref = useRef(0);
    const prevDeps = useRef<React.DependencyList>(dependencies);

    if (!depsShallowEqual(prevDeps.current, dependencies)) {
        ref.current += 1;
        prevDeps.current = dependencies;
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(callback, [ref.current]);
}

/**
 * Dependency-list comparison memo hook.
 *
 * Recomputes the value only when the dependency list changes by
 * {@link depsShallowEqual} (see {@link useDeepCompareEffect}) — replacing the
 * old `JSON.stringify` deep compare that ran on every render of the feed.
 */
export function useDeepCompareMemo<T>(
    factory: () => T,
    dependencies: React.DependencyList
): T {
    const ref = useRef(0);
    const prevDeps = useRef<React.DependencyList>(dependencies);

    if (!depsShallowEqual(prevDeps.current, dependencies)) {
        ref.current += 1;
        prevDeps.current = dependencies;
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(factory, [ref.current]);
}
