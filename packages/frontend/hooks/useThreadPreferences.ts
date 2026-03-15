import { useState, useEffect } from 'react';
import { getData } from '@/utils/storage';
import { STORAGE_KEYS } from '@/lib/constants';

export type SortOrder = 'top' | 'oldest' | 'newest';

interface ThreadPreferences {
    treeView: boolean;
    sortOrder: SortOrder;
}

const DEFAULTS: ThreadPreferences = {
    treeView: false,
    sortOrder: 'top',
};

export function useThreadPreferences(): ThreadPreferences {
    const [preferences, setPreferences] = useState<ThreadPreferences>(DEFAULTS);

    useEffect(() => {
        let mounted = true;

        async function load() {
            const [savedTree, savedSort] = await Promise.all([
                getData<boolean>(STORAGE_KEYS.THREAD_TREE_VIEW),
                getData<SortOrder>(STORAGE_KEYS.THREAD_SORT),
            ]);

            if (!mounted) return;

            const loaded: ThreadPreferences = {
                treeView: typeof savedTree === 'boolean' ? savedTree : DEFAULTS.treeView,
                sortOrder: savedSort ?? DEFAULTS.sortOrder,
            };

            setPreferences((prev) => {
                if (prev.treeView === loaded.treeView && prev.sortOrder === loaded.sortOrder) {
                    return prev;
                }
                return loaded;
            });
        }

        load();
        return () => { mounted = false; };
    }, []);

    return preferences;
}
