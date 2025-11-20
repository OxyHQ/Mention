import { useCallback, useEffect, useRef } from 'react';
import { useOxy } from '@oxyhq/services';
import { usePrivacyStore } from '@/stores/privacyStore';

interface UsePrivacyControlsOptions {
    autoRefresh?: boolean;
    minIntervalMs?: number;
}

const DEFAULT_INTERVAL = 2 * 60 * 1000; // 2 minutes

export function usePrivacyControls(options?: UsePrivacyControlsOptions) {
    const { autoRefresh = true, minIntervalMs = DEFAULT_INTERVAL } = options || {};
    const { oxyServices, isAuthenticated } = useOxy();

    // Use individual selectors for optimal performance (Zustand automatically shallow compares)
    const blockedSet = usePrivacyStore((state) => state.blockedSet);
    const restrictedSet = usePrivacyStore((state) => state.restrictedSet);
    const loading = usePrivacyStore((state) => state.loading);
    const lastFetchedAt = usePrivacyStore((state) => state.lastFetchedAt);
    const hasFetched = usePrivacyStore((state) => state.hasFetched);

    const setLists = usePrivacyStore((state) => state.setLists);
    const setLoading = usePrivacyStore((state) => state.setLoading);
    const setError = usePrivacyStore((state) => state.setError);
    const resetStore = usePrivacyStore((state) => state.reset);

    // Use ref to track if we've initialized to avoid unnecessary checks
    const hasInitializedRef = useRef(false);

    const refreshPrivacyLists = useCallback(async () => {
        if (!oxyServices) return;
        setLoading(true);
        try {
            const [blockedUsers, restrictedUsers] = await Promise.all([
                oxyServices.getBlockedUsers?.(),
                oxyServices.getRestrictedUsers?.(),
            ]);

            const blocked = Array.isArray(blockedUsers)
                ? blockedUsers
                      .map((entry: any) => {
                          if (entry?.blockedId) {
                              return typeof entry.blockedId === 'string' ? entry.blockedId : entry.blockedId._id;
                          }
                          return entry?.id || entry?._id || entry?.userId || entry?.targetId;
                      })
                      .filter(Boolean)
                : [];

            const restricted = Array.isArray(restrictedUsers)
                ? restrictedUsers
                      .map((entry: any) => {
                          if (entry?.restrictedId) {
                              return typeof entry.restrictedId === 'string' ? entry.restrictedId : entry.restrictedId._id;
                          }
                          return entry?.id || entry?._id || entry?.userId || entry?.targetId;
                      })
                      .filter(Boolean)
                : [];

            setLists({
                blockedIds: blocked,
                restrictedIds: restricted,
                lastFetchedAt: Date.now(),
            });
            setError(undefined);
        } catch (error: any) {
            const message = error?.message || 'Failed to load privacy data';
            console.error('[usePrivacyControls] Unable to load privacy lists:', error);
            setError(message);
        } finally {
            setLoading(false);
        }
    }, [oxyServices, setError, setLists, setLoading]);

    useEffect(() => {
        if (!isAuthenticated) {
            resetStore();
        }
    }, [isAuthenticated, resetStore]);

    useEffect(() => {
        if (!autoRefresh || !isAuthenticated || !oxyServices) {
            return;
        }

        const now = Date.now();
        const shouldRefresh =
            !hasFetched ||
            !lastFetchedAt ||
            (typeof minIntervalMs === 'number' && now - lastFetchedAt > minIntervalMs);

        if (shouldRefresh && !loading) {
            refreshPrivacyLists();
            hasInitializedRef.current = true;
        }
    }, [
        autoRefresh,
        isAuthenticated,
        oxyServices,
        hasFetched,
        lastFetchedAt,
        minIntervalMs,
        refreshPrivacyLists,
        loading,
    ]);

    // Stable callbacks - Sets are already memoized in store
    const isBlocked = useCallback(
        (userId?: string | null): boolean => {
            if (!userId) return false;
            return blockedSet.has(String(userId));
        },
        [blockedSet],
    );

    const isRestricted = useCallback(
        (userId?: string | null): boolean => {
            if (!userId) return false;
            return restrictedSet.has(String(userId));
        },
        [restrictedSet],
    );

    const shouldGhostInteractions = useCallback(
        (userId?: string | null): boolean => {
            return isRestricted(userId);
        },
        [isRestricted],
    );

    return {
        blockedSet,
        restrictedSet,
        loading,
        refreshPrivacyLists,
        isBlocked,
        isRestricted,
        shouldGhostInteractions,
    };
}

