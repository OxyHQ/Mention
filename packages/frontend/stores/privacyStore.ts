import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

interface PrivacyStoreState {
    blockedIds: string[];
    restrictedIds: string[];
    blockedSet: Set<string>;
    restrictedSet: Set<string>;
    loading: boolean;
    error?: string;
    lastFetchedAt?: number;
    hasFetched: boolean;
    setLists: (payload: { blockedIds: string[]; restrictedIds: string[]; lastFetchedAt: number }) => void;
    setLoading: (loading: boolean) => void;
    setError: (error?: string) => void;
    reset: () => void;
}

// Helper to create Sets from arrays - memoized at store level
function createSets(blockedIds: string[], restrictedIds: string[]): { blockedSet: Set<string>; restrictedSet: Set<string> } {
    return {
        blockedSet: new Set(blockedIds),
        restrictedSet: new Set(restrictedIds),
    };
}

export const usePrivacyStore = create<PrivacyStoreState>()(
    subscribeWithSelector((set) => ({
        blockedIds: [],
        restrictedIds: [],
        blockedSet: new Set<string>(),
        restrictedSet: new Set<string>(),
        loading: false,
        error: undefined,
        lastFetchedAt: undefined,
        hasFetched: false,
        setLists: ({ blockedIds, restrictedIds, lastFetchedAt }) => {
            const { blockedSet, restrictedSet } = createSets(blockedIds, restrictedIds);
            set({
                blockedIds,
                restrictedIds,
                blockedSet,
                restrictedSet,
                lastFetchedAt,
                hasFetched: true,
            });
        },
        setLoading: (loading) => set({ loading }),
        setError: (error) => set({ error }),
        reset: () => {
            const emptySets = createSets([], []);
            set({
                blockedIds: [],
                restrictedIds: [],
                ...emptySets,
                loading: false,
                error: undefined,
                lastFetchedAt: undefined,
                hasFetched: false,
            });
        },
    }))
);

