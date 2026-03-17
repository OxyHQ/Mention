import { create } from 'zustand';
import { getData, storeData } from '@/utils/storage';
import { STORAGE_KEYS } from '@/lib/constants';

export type SortOrder = 'top' | 'oldest' | 'newest';

interface ThreadPreferencesState {
    treeView: boolean;
    sortOrder: SortOrder;
    loaded: boolean;
    setTreeView: (value: boolean) => void;
    setSortOrder: (value: SortOrder) => void;
    load: () => Promise<void>;
}

const DEFAULTS = {
    treeView: false,
    sortOrder: 'top' as SortOrder,
};

export const useThreadPreferencesStore = create<ThreadPreferencesState>((set, get) => ({
    treeView: DEFAULTS.treeView,
    sortOrder: DEFAULTS.sortOrder,
    loaded: false,

    setTreeView: (value: boolean) => {
        set({ treeView: value });
        storeData(STORAGE_KEYS.THREAD_TREE_VIEW, value);
    },

    setSortOrder: (value: SortOrder) => {
        set({ sortOrder: value });
        storeData(STORAGE_KEYS.THREAD_SORT, value);
    },

    load: async () => {
        if (get().loaded) return;
        const [savedTree, savedSort] = await Promise.all([
            getData<boolean>(STORAGE_KEYS.THREAD_TREE_VIEW),
            getData<SortOrder>(STORAGE_KEYS.THREAD_SORT),
        ]);
        set({
            treeView: typeof savedTree === 'boolean' ? savedTree : DEFAULTS.treeView,
            sortOrder: savedSort ?? DEFAULTS.sortOrder,
            loaded: true,
        });
    },
}));

// Load preferences from storage on first import
useThreadPreferencesStore.getState().load();

/**
 * Convenience hook that returns just the preference values (backward-compatible).
 */
export function useThreadPreferences(): { treeView: boolean; sortOrder: SortOrder } {
    const treeView = useThreadPreferencesStore((s) => s.treeView);
    const sortOrder = useThreadPreferencesStore((s) => s.sortOrder);
    return { treeView, sortOrder };
}
