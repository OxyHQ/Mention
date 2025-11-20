import { create } from 'zustand';

interface PrivacyStoreState {
    blockedIds: string[];
    restrictedIds: string[];
    loading: boolean;
    error?: string;
    lastFetchedAt?: number;
    hasFetched: boolean;
    setLists: (payload: { blockedIds: string[]; restrictedIds: string[]; lastFetchedAt: number }) => void;
    setLoading: (loading: boolean) => void;
    setError: (error?: string) => void;
    reset: () => void;
}

export const usePrivacyStore = create<PrivacyStoreState>((set) => ({
    blockedIds: [],
    restrictedIds: [],
    loading: false,
    error: undefined,
    lastFetchedAt: undefined,
    hasFetched: false,
    setLists: ({ blockedIds, restrictedIds, lastFetchedAt }) =>
        set({
            blockedIds,
            restrictedIds,
            lastFetchedAt,
            hasFetched: true,
        }),
    setLoading: (loading) => set({ loading }),
    setError: (error) => set({ error }),
    reset: () =>
        set({
            blockedIds: [],
            restrictedIds: [],
            loading: false,
            error: undefined,
            lastFetchedAt: undefined,
            hasFetched: false,
        }),
}));

