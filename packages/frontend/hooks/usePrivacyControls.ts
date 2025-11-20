import { useCallback, useEffect, useMemo } from 'react';
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

    const blockedIds = usePrivacyStore((state) => state.blockedIds);
    const restrictedIds = usePrivacyStore((state) => state.restrictedIds);
    const loading = usePrivacyStore((state) => state.loading);
    const lastFetchedAt = usePrivacyStore((state) => state.lastFetchedAt);
    const hasFetched = usePrivacyStore((state) => state.hasFetched);
    const setLists = usePrivacyStore((state) => state.setLists);
    const setLoading = usePrivacyStore((state) => state.setLoading);
    const setError = usePrivacyStore((state) => state.setError);
    const resetStore = usePrivacyStore((state) => state.reset);

    // Normalize legacy state name if it exists
    const normalizedHasFetched = typeof hasFetched === 'boolean' ? hasFetched : false;

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
            !normalizedHasFetched ||
            !lastFetchedAt ||
            (typeof minIntervalMs === 'number' && now - lastFetchedAt > minIntervalMs);

        if (shouldRefresh && !loading) {
            refreshPrivacyLists();
        }
    }, [
        autoRefresh,
        isAuthenticated,
        oxyServices,
        normalizedHasFetched,
        lastFetchedAt,
        minIntervalMs,
        refreshPrivacyLists,
        loading,
    ]);

    const blockedSet = useMemo(() => new Set(blockedIds), [blockedIds]);
    const restrictedSet = useMemo(() => new Set(restrictedIds), [restrictedIds]);

    const isBlocked = useCallback(
        (userId?: string | null): boolean => {
            if (!userId) return false;
            return blockedSet.has(userId);
        },
        [blockedSet],
    );

    const isRestricted = useCallback(
        (userId?: string | null): boolean => {
            if (!userId) return false;
            return restrictedSet.has(userId);
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
        blockedIds,
        restrictedIds,
        blockedSet,
        restrictedSet,
        loading,
        refreshPrivacyLists,
        isBlocked,
        isRestricted,
        shouldGhostInteractions,
    };
}

