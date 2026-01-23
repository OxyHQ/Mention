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

// Helper to compare arrays for equality
function arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((val, idx) => val === sortedB[idx]);
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
        setLists: ({ blockedIds, restrictedIds, lastFetchedAt }) =>
            set((state) => {
                // Only create new Sets if the arrays have actually changed
                const blockedChanged = !arraysEqual(state.blockedIds, blockedIds);
                const restrictedChanged = !arraysEqual(state.restrictedIds, restrictedIds);

                if (!blockedChanged && !restrictedChanged) {
                    // Only update timestamp if nothing else changed
                    return { lastFetchedAt, hasFetched: true };
                }

                return {
                    blockedIds: blockedChanged ? blockedIds : state.blockedIds,
                    restrictedIds: restrictedChanged ? restrictedIds : state.restrictedIds,
                    blockedSet: blockedChanged ? new Set(blockedIds) : state.blockedSet,
                    restrictedSet: restrictedChanged ? new Set(restrictedIds) : state.restrictedSet,
                    lastFetchedAt,
                    hasFetched: true,
                };
            }),
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

