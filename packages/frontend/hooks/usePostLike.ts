import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';
import { logger } from '@/lib/logger';

export function usePostLike(postId: string | undefined, isLiked: boolean) {
    const { likePost, unlikePost } = usePostsStore();
    const pendingRef = useRef(false);

    const toggleLike = useCallback(async () => {
        if (!postId || pendingRef.current) return;

        pendingRef.current = true;
        try {
            const action = isLiked
                ? unlikePost({ postId, type: 'post' })
                : likePost({ postId, type: 'post' });

            await action;
        } catch (error) {
            logger.error('Error toggling like');
        } finally {
            pendingRef.current = false;
        }
    }, [postId, isLiked, likePost, unlikePost]);

    return toggleLike;
}
