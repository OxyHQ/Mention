import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';
import { logger } from '@oxy.so/core/logger';

/**
 * @param source Optional originating feed descriptor (e.g. 'videos', 'for_you',
 *   'author|<id>'). Attached to the LIKE write for surface-aware engagement
 *   attribution; an unlike carries no interest signal and ignores it.
 */
export function usePostLike(postId: string | undefined, isLiked: boolean, source?: string) {
    // Select each action: a bare usePostsStore() subscribes this row to the
    // whole store and re-renders it on every unrelated posts-store write.
    const likePost = usePostsStore((s) => s.likePost);
    const unlikePost = usePostsStore((s) => s.unlikePost);
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
            logger.error('Error toggling like', error);
        } finally {
            pendingRef.current = false;
        }
    }, [postId, isLiked, likePost, unlikePost, source]);

    return toggleLike;
}
