import { useState, useCallback } from 'react';

interface CacheEntry<T> {
    data: T;
    timestamp: number;
}

interface CacheOptions {
    duration?: number;
    deduplicate?: boolean;
}

const DEFAULT_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry<any>>();
const pendingRequests = new Map<string, Promise<any>>();

export function useCache() {
    const getCached = useCallback(<T>(key: string, options: CacheOptions = {}): T | null => {
        const entry = cache.get(key);
        const now = Date.now();
        const duration = options.duration || DEFAULT_CACHE_DURATION;

        if (entry && now - entry.timestamp < duration) {
            return entry.data;
        }
        return null;
    }, []);

    const setCached = useCallback(<T>(key: string, data: T): void => {
        cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }, []);

    const fetchWithCache = useCallback(async <T>(
        key: string,
        fetcher: () => Promise<T>,
        options: CacheOptions = {}
    ): Promise<T> => {
        const cached = getCached<T>(key, options);
        if (cached) {
            return cached;
        }

        if (options.deduplicate && pendingRequests.has(key)) {
            return pendingRequests.get(key);
        }

        const promise = fetcher();
        if (options.deduplicate) {
            pendingRequests.set(key, promise);
        }

        try {
            const data = await promise;
            setCached(key, data);
            return data;
        } finally {
            if (options.deduplicate) {
                pendingRequests.delete(key);
            }
        }
    }, [getCached, setCached]);

    const invalidateCache = useCallback((key?: string) => {
        if (key) {
            cache.delete(key);
        } else {
            cache.clear();
        }
    }, []);

    return {
        getCached,
        setCached,
        fetchWithCache,
        invalidateCache
    };
}