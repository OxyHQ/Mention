import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';

export function usePostSave(postId: string | undefined, isSaved: boolean) {
    const { savePost, unsavePost } = usePostsStore();
    const actionRef = useRef<Promise<void> | null>(null);

    const toggleSave = useCallback(async () => {
        if (!postId || actionRef.current) return;

        try {
            const action = isSaved
                ? unsavePost({ postId })
                : savePost({ postId });

            actionRef.current = action;
            await action;
        } catch (error) {
            console.error('Error toggling save:', error);
        } finally {
            setTimeout(() => {
                actionRef.current = null;
            }, 300);
        }
    }, [postId, isSaved, savePost, unsavePost]);

    return toggleSave;
}

