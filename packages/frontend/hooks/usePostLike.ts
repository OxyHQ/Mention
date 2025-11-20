import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';

export function usePostLike(postId: string | undefined, isLiked: boolean) {
    const { likePost, unlikePost } = usePostsStore();
    const actionRef = useRef<Promise<void> | null>(null);

    const toggleLike = useCallback(async () => {
        if (!postId || actionRef.current) return;

        try {
            const action = isLiked
                ? unlikePost({ postId, type: 'post' })
                : likePost({ postId, type: 'post' });

            actionRef.current = action;
            await action;
        } catch (error) {
            console.error('Error toggling like:', error);
        } finally {
            setTimeout(() => {
                actionRef.current = null;
            }, 300);
        }
    }, [postId, isLiked, likePost, unlikePost]);

    return toggleLike;
}

