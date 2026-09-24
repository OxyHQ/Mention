import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';
import { logger } from '@oxy.so/core/logger';

export function usePostVote(
    postId: string | undefined,
    isLiked: boolean,
    isDownvoted: boolean,
) {
    // Select each action: a bare usePostsStore() subscribes this row to the
    // whole store and re-renders it on every unrelated posts-store write.
    const likePost = usePostsStore((s) => s.likePost);
    const unlikePost = usePostsStore((s) => s.unlikePost);
    const downvotePost = usePostsStore((s) => s.downvotePost);
    const upvotePendingRef = useRef(false);
    const downvotePendingRef = useRef(false);

    const toggleUpvote = useCallback(async () => {
        if (!postId || upvotePendingRef.current) return;

        upvotePendingRef.current = true;
        try {
            if (isLiked) {
                await unlikePost({ postId, type: 'post' });
            } else {
                await likePost({ postId, type: 'post' });
            }
        } catch (error) {
            logger.error('Error toggling upvote', error);
        } finally {
            upvotePendingRef.current = false;
        }
    }, [postId, isLiked, likePost, unlikePost]);

    const toggleDownvote = useCallback(async () => {
        if (!postId || downvotePendingRef.current) return;

        downvotePendingRef.current = true;
        try {
            if (isDownvoted) {
                await unlikePost({ postId, type: 'post' });
            } else {
                await downvotePost({ postId, type: 'post' });
            }
        } catch (error) {
            logger.error('Error toggling downvote', error);
        } finally {
            downvotePendingRef.current = false;
        }
    }, [postId, isDownvoted, unlikePost, downvotePost]);

    return { toggleUpvote, toggleDownvote };
}
