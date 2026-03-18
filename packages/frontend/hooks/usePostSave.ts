import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';
import { logger } from '@/lib/logger';

export function usePostSave(postId: string | undefined, isSaved: boolean) {
    const { savePost, unsavePost } = usePostsStore();
    const pendingRef = useRef(false);

    const toggleSave = useCallback(async () => {
        if (!postId || pendingRef.current) return;

        pendingRef.current = true;
        try {
            const action = isSaved
                ? unsavePost({ postId })
                : savePost({ postId });

            await action;
        } catch (error) {
            logger.error('Error toggling save', { error });
        } finally {
            pendingRef.current = false;
        }
    }, [postId, isSaved, savePost, unsavePost]);

    return toggleSave;
}

