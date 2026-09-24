import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';
import { logger } from '@oxy.so/core/logger';

/**
 * @param source Optional originating feed descriptor for surface-aware
 *   engagement attribution; attached to the SAVE write, ignored on unsave.
 */
export function usePostSave(postId: string | undefined, isSaved: boolean, source?: string) {
    // Select each action: a bare usePostsStore() subscribes this row to the
    // whole store and re-renders it on every unrelated posts-store write.
    const savePost = usePostsStore((s) => s.savePost);
    const unsavePost = usePostsStore((s) => s.unsavePost);
    const pendingRef = useRef(false);

    const toggleSave = useCallback(async () => {
        if (!postId || pendingRef.current) return;

        pendingRef.current = true;
        try {
            const action = isSaved
                ? unsavePost({ postId })
                : savePost({ postId }, source);

            await action;
        } catch (error) {
            logger.error('Error toggling save', error);
        } finally {
            pendingRef.current = false;
        }
    }, [postId, isSaved, savePost, unsavePost, source]);

    return toggleSave;
}
