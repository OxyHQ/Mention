import { useCallback, useRef } from 'react';
import { usePostsStore } from '@/stores/postsStore';
import { logger } from '@/lib/logger';

export function usePostVote(
    postId: string | undefined,
    isLiked: boolean,
    isDownvoted: boolean,
) {
    const { likePost, unlikePost, downvotePost } = usePostsStore();
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
            logger.error('Error toggling upvote', { error });
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
            logger.error('Error toggling downvote', { error });
        } finally {
            downvotePendingRef.current = false;
        }
    }, [postId, isDownvoted, unlikePost, downvotePost]);

    return { toggleUpvote, toggleDownvote };
}
