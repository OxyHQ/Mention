import { useEffect, useRef, useMemo } from 'react';
import { deepEqual } from '@/utils/feedUtils';

/**
 * Deep comparison hook for useEffect dependencies
 * Prevents unnecessary effect runs when objects/arrays change by reference but not by value
 */
export function useDeepCompareEffect(
    callback: React.EffectCallback,
    dependencies: React.DependencyList
) {
    const currentDependenciesRef = useRef<React.DependencyList | undefined>(undefined);

    if (!currentDependenciesRef.current || !deepEqual(currentDependenciesRef.current, dependencies)) {
        currentDependenciesRef.current = dependencies;
    }

    useEffect(callback, currentDependenciesRef.current);
}

/**
 * Deep comparison memo hook
 * Memoizes a value and only recalculates when dependencies change by deep equality
 */
export function useDeepCompareMemo<T>(
    factory: () => T,
    dependencies: React.DependencyList
): T {
    const currentDependenciesRef = useRef<React.DependencyList | undefined>(undefined);

    if (!currentDependenciesRef.current || !deepEqual(currentDependenciesRef.current, dependencies)) {
        currentDependenciesRef.current = dependencies;
    }

    return useMemo(factory, currentDependenciesRef.current);
}

