import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@oxyhq/services';
import type { BlockedUser, RestrictedUser } from '@oxyhq/core';
import { usePrivacyStore } from '@/stores/privacyStore';
import { logger } from '@/lib/logger';

interface UsePrivacyControlsOptions {
    autoRefresh?: boolean;
    minIntervalMs?: number;
}

const DEFAULT_INTERVAL = 2 * 60 * 1000; // 2 minutes

function extractListId(entry: BlockedUser | RestrictedUser): string | undefined {
    const target = 'blockedId' in entry ? entry.blockedId : entry.restrictedId;
    if (target) {
        return typeof target === 'string' ? target : target._id;
    }
    return entry._id ?? entry.userId;
}

export function usePrivacyControls(options?: UsePrivacyControlsOptions) {
    const { autoRefresh = true, minIntervalMs = DEFAULT_INTERVAL } = options || {};
    const { oxyServices, isAuthenticated, isAuthResolved, user } = useAuth();
    const viewerId = user?.id;

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

    // In-flight guard: prevents overlapping fetches independent of the store's
    // `loading` flag (the store toggling `loading` must NOT be what re-triggers
    // the auto-refresh effect, or a 401 → setLoading(false) re-renders into a
    // refetch storm).
    const inFlightRef = useRef(false);
    // Identity of the viewer we last attempted a fetch for. We fetch at most
    // once per identity; a failed attempt (e.g. 401) still marks the identity
    // as attempted so it does NOT immediately re-fire.
    const attemptedViewerRef = useRef<string | null>(null);

    const refreshPrivacyLists = useCallback(async () => {
        if (!oxyServices) return;
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        setLoading(true);
        try {
            const [blockedUsers, restrictedUsers] = await Promise.all([
                oxyServices.getBlockedUsers?.(),
                oxyServices.getRestrictedUsers?.(),
            ]);

            const blocked = Array.isArray(blockedUsers)
                ? blockedUsers.map(extractListId).filter((id): id is string => Boolean(id))
                : [];

            const restricted = Array.isArray(restrictedUsers)
                ? restrictedUsers.map(extractListId).filter((id): id is string => Boolean(id))
                : [];

            setLists({
                blockedIds: blocked,
                restrictedIds: restricted,
                lastFetchedAt: Date.now(),
            });
            setError(undefined);
        } catch (error: unknown) {
            // Fail quietly: record a timestamp so `shouldRefresh` becomes false
            // and a transient/unauthorized failure does NOT trigger an immediate
            // refetch storm. Lists stay empty until the interval elapses or the
            // viewer identity changes.
            const message = error instanceof Error ? error.message : 'Failed to load privacy data';
            logger.error('[usePrivacyControls] Unable to load privacy lists', { error });
            setError(message);
            setLists({ blockedIds: [], restrictedIds: [], lastFetchedAt: Date.now() });
        } finally {
            inFlightRef.current = false;
            setLoading(false);
        }
    }, [oxyServices, setError, setLists, setLoading]);

    useEffect(() => {
        // Reset the store AND the per-identity attempt guard whenever the
        // session goes away, so signing in as a different user re-fetches.
        if (isAuthResolved && !isAuthenticated) {
            attemptedViewerRef.current = null;
            resetStore();
        }
    }, [isAuthResolved, isAuthenticated, resetStore]);

    useEffect(() => {
        // Gate strictly on a resolved, authenticated session with a known viewer.
        // During cold-boot (`!isAuthResolved`) `isAuthenticated` is UNDETERMINED,
        // so we must NOT fire — that is the window that produced the 401 storm.
        if (!autoRefresh || !isAuthResolved || !isAuthenticated || !oxyServices || !viewerId) {
            return;
        }

        // Fetch at most once per viewer identity (until the interval elapses).
        const identityChanged = attemptedViewerRef.current !== viewerId;
        const now = Date.now();
        const intervalElapsed =
            typeof minIntervalMs === 'number' && !!lastFetchedAt && now - lastFetchedAt > minIntervalMs;
        const shouldRefresh = identityChanged || (!hasFetched && !lastFetchedAt) || intervalElapsed;

        if (shouldRefresh && !inFlightRef.current) {
            attemptedViewerRef.current = viewerId;
            refreshPrivacyLists();
        }
    }, [
        autoRefresh,
        isAuthResolved,
        isAuthenticated,
        oxyServices,
        viewerId,
        hasFetched,
        lastFetchedAt,
        minIntervalMs,
        refreshPrivacyLists,
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

