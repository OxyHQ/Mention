import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';

export function usePostRepost(postId: string | undefined, isReposted: boolean) {
    const { repostPost, unrepostPost } = usePostsStore();
    const pendingRef = useRef(false);

    const toggleRepost = useCallback(async () => {
        if (!postId || pendingRef.current) return;

        pendingRef.current = true;
        try {
            const action = isReposted
                ? unrepostPost({ postId })
                : repostPost({ postId });

            await action;
        } catch (error) {
            console.error('Error toggling repost:', error);
        } finally {
            pendingRef.current = false;
        }
    }, [postId, isReposted, repostPost, unrepostPost]);

    return toggleRepost;
}

