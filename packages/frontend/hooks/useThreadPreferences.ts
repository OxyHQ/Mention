import { create } from 'zustand';
import { Storage } from '@/utils/storage';
import { STORAGE_KEYS } from '@/lib/constants';
import type { IconName } from '@/lib/icons';

export type SortOrder = 'top' | 'oldest' | 'newest';

/** How a post's like control renders — a heart, or an up/down vote pill. */
export type VoteStyle = 'heart' | 'pill';

export const SORT_TO_API: Record<SortOrder, string> = {
    top: 'best',
    oldest: 'oldest',
    newest: 'recent',
};

export const SORT_OPTIONS: { value: SortOrder; icon: IconName; labelKey: string; defaultLabel: string }[] = [
    { value: 'top', icon: 'trending-up', labelKey: 'replyPreferences.sortTop', defaultLabel: 'Top replies first' },
    { value: 'oldest', icon: 'time-outline', labelKey: 'replyPreferences.sortOldest', defaultLabel: 'Oldest replies first' },
    { value: 'newest', icon: 'arrow-down', labelKey: 'replyPreferences.sortNewest', defaultLabel: 'Newest replies first' },
];

interface ThreadPreferencesState {
    treeView: boolean;
    sortOrder: SortOrder;
    voteStyle: VoteStyle;
    loaded: boolean;
    setTreeView: (value: boolean) => void;
    setSortOrder: (value: SortOrder) => void;
    setVoteStyle: (value: VoteStyle) => void;
    load: () => Promise<void>;
}

const DEFAULTS = {
    treeView: false,
    sortOrder: 'top' as SortOrder,
    voteStyle: 'heart' as VoteStyle,
};

export const useThreadPreferencesStore = create<ThreadPreferencesState>((set, get) => ({
    treeView: DEFAULTS.treeView,
    sortOrder: DEFAULTS.sortOrder,
    voteStyle: DEFAULTS.voteStyle,
    loaded: false,

    setTreeView: (value: boolean) => {
        set({ treeView: value });
        Storage.set(STORAGE_KEYS.THREAD_TREE_VIEW, value);
    },

    setSortOrder: (value: SortOrder) => {
        set({ sortOrder: value });
        Storage.set(STORAGE_KEYS.THREAD_SORT, value);
    },

    setVoteStyle: (value: VoteStyle) => {
        set({ voteStyle: value });
        Storage.set(STORAGE_KEYS.VOTE_STYLE, value);
    },

    load: async () => {
        if (get().loaded) return;
        const [savedTree, savedSort, savedVoteStyle] = await Promise.all([
            Storage.get<boolean>(STORAGE_KEYS.THREAD_TREE_VIEW),
            Storage.get<SortOrder>(STORAGE_KEYS.THREAD_SORT),
            Storage.get<VoteStyle>(STORAGE_KEYS.VOTE_STYLE),
        ]);
        set({
            treeView: typeof savedTree === 'boolean' ? savedTree : DEFAULTS.treeView,
            sortOrder: savedSort ?? DEFAULTS.sortOrder,
            voteStyle: savedVoteStyle === 'heart' || savedVoteStyle === 'pill'
                ? savedVoteStyle
                : DEFAULTS.voteStyle,
            loaded: true,
        });
    },
}));

// Load preferences from storage on first import
useThreadPreferencesStore.getState().load().catch(() => {});

/**
 * Convenience hook that returns just the preference values (backward-compatible).
 */
export function useThreadPreferences(): { treeView: boolean; sortOrder: SortOrder } {
    const treeView = useThreadPreferencesStore((s) => s.treeView);
    const sortOrder = useThreadPreferencesStore((s) => s.sortOrder);
    return { treeView, sortOrder };
}
