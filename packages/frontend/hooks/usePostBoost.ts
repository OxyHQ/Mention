import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';
import { logger } from '@/lib/logger';

export function usePostBoost(postId: string | undefined, isBoosted: boolean) {
    const { boostPost, unboostPost } = usePostsStore();
    const pendingRef = useRef(false);

    const toggleBoost = useCallback(async () => {
        if (!postId || pendingRef.current) return;

        pendingRef.current = true;
        try {
            const action = isBoosted
                ? unboostPost({ postId })
                : boostPost({ postId });

            await action;
        } catch (error) {
            logger.error('Error toggling boost', { error });
        } finally {
            pendingRef.current = false;
        }
    }, [postId, isBoosted, boostPost, unboostPost]);

    return toggleBoost;
}
