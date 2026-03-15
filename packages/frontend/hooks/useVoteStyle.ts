import { useState, useEffect } from 'react';
import { getData } from '@/utils/storage';
import { STORAGE_KEYS } from '@/lib/constants';

export type VoteStyle = 'heart' | 'pill';

const DEFAULT_VOTE_STYLE: VoteStyle = 'heart';

export function useVoteStyle(): VoteStyle {
    const [voteStyle, setVoteStyle] = useState<VoteStyle>(DEFAULT_VOTE_STYLE);

    useEffect(() => {
        let mounted = true;

        async function load() {
            const saved = await getData<VoteStyle>(STORAGE_KEYS.VOTE_STYLE);
            if (!mounted) return;
            if (saved === 'heart' || saved === 'pill') {
                setVoteStyle(saved);
            }
        }

        load();
        return () => { mounted = false; };
    }, []);

    return voteStyle;
}
