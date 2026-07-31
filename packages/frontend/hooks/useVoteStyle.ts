import { useThreadPreferencesStore } from '@/hooks/useThreadPreferences';
import type { VoteStyle } from '@/hooks/useThreadPreferences';

export type { VoteStyle };

/**
 * The viewer's like-control style, from the one shared thread-preferences store.
 *
 * It reads the store rather than loading storage per caller: a per-caller copy
 * meant every mounted post kept whichever value it had loaded, so changing the
 * style in settings left already-rendered posts on the old one until they
 * remounted.
 */
export function useVoteStyle(): VoteStyle {
    return useThreadPreferencesStore((state) => state.voteStyle);
}
