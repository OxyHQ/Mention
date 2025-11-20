import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';

export function usePostRepost(postId: string | undefined, isReposted: boolean) {
    const { repostPost, unrepostPost } = usePostsStore();
    const actionRef = useRef<Promise<void> | null>(null);

    const toggleRepost = useCallback(async () => {
        if (!postId || actionRef.current) return;

        try {
            const action = isReposted
                ? unrepostPost({ postId })
                : repostPost({ postId });

            actionRef.current = action;
            await action;
        } catch (error) {
            console.error('Error toggling repost:', error);
        } finally {
            setTimeout(() => {
                actionRef.current = null;
            }, 300);
        }
    }, [postId, isReposted, repostPost, unrepostPost]);

    return toggleRepost;
}

