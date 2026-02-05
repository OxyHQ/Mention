import { useEffect, useRef, useMemo } from 'react';
import { deepEqual } from '@/utils/feedUtils';

/**
 * Deep comparison hook for useEffect dependencies
 * Uses a counter ref to trigger effects only when deep equality changes
 */
export function useDeepCompareEffect(
    callback: React.EffectCallback,
    dependencies: React.DependencyList
) {
    const ref = useRef(0);
    const prevDeps = useRef<React.DependencyList>(dependencies);

    if (!deepEqual(prevDeps.current, dependencies)) {
        ref.current += 1;
        prevDeps.current = dependencies;
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(callback, [ref.current]);
}

/**
 * Deep comparison memo hook
 * Memoizes a value and only recalculates when dependencies change by deep equality
 */
export function useDeepCompareMemo<T>(
    factory: () => T,
    dependencies: React.DependencyList
): T {
    const ref = useRef(0);
    const prevDeps = useRef<React.DependencyList>(dependencies);

    if (!deepEqual(prevDeps.current, dependencies)) {
        ref.current += 1;
        prevDeps.current = dependencies;
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(factory, [ref.current]);
}
