import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';
import { logger } from '@/lib/logger';

/**
 * @param source Optional originating feed descriptor (e.g. 'videos', 'for_you',
 *   'author|<id>'). Attached to the LIKE write for surface-aware engagement
 *   attribution; an unlike carries no interest signal and ignores it.
 */
export function usePostLike(postId: string | undefined, isLiked: boolean, source?: string) {
    const { likePost, unlikePost } = usePostsStore();
    const pendingRef = useRef(false);

    const toggleLike = useCallback(async () => {
        if (!postId || pendingRef.current) return;

        pendingRef.current = true;
        try {
            const action = isLiked
                ? unlikePost({ postId, type: 'post' })
                : likePost({ postId, type: 'post' }, source);

            await action;
        } catch (error) {
            logger.error('Error toggling like', { error });
        } finally {
            pendingRef.current = false;
        }
    }, [postId, isLiked, likePost, unlikePost, source]);

    return toggleLike;
}
