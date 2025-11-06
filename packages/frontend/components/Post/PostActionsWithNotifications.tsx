import React from 'react';
import PostActions from './PostActions';
import { useNotificationActions } from '../../hooks/useNotificationActions';

interface Engagement {
    replies: number;
    reposts: number;
    likes: number;
}

interface Props {
    engagement: Engagement;
    isLiked?: boolean;
    isReposted?: boolean;
    isSaved?: boolean;
    postId: string;
    postAuthorId: string;
    onReply: () => void;
    onRepost: () => void;
    onLike: () => void;
    onSave: () => void;
    onShare: () => void;
    hideLikeCounts?: boolean;
    hideShareCounts?: boolean;
    hideReplyCounts?: boolean;
    hideSaveCounts?: boolean;
}

const PostActionsWithNotifications: React.FC<Props> = ({
    engagement,
    isLiked,
    isReposted,
    isSaved,
    postId,
    postAuthorId,
    onReply,
    onRepost,
    onLike,
    onSave,
    onShare,
    hideLikeCounts,
    hideShareCounts,
    hideReplyCounts,
    hideSaveCounts,
}) => {
    const { notifyLike, notifyRepost } = useNotificationActions();

    const handleLike = async () => {
        try {
            // Call the original onLike handler
            onLike();

            // Create notification if this is a new like (not unliking)
            if (!isLiked) {
                await notifyLike(postId, postAuthorId);
            }
        } catch (error) {
            console.error('Error handling like with notification:', error);
            // Still call the original handler even if notification fails
            onLike();
        }
    };

    const handleRepost = async () => {
        try {
            // Call the original onRepost handler
            onRepost();

            // Create notification if this is a new repost (not unreposting)
            if (!isReposted) {
                await notifyRepost(postId, postAuthorId);
            }
        } catch (error) {
            console.error('Error handling repost with notification:', error);
            // Still call the original handler even if notification fails
            onRepost();
        }
    };

    const handleReply = () => {
        // For replies, we'll handle notifications in the reply creation flow
        onReply();
    };

    return (
        <PostActions
            engagement={engagement}
            isLiked={isLiked}
            isReposted={isReposted}
            isSaved={isSaved}
            onReply={handleReply}
            onRepost={handleRepost}
            onLike={handleLike}
            onSave={onSave}
            onShare={onShare}
            hideLikeCounts={hideLikeCounts}
            hideShareCounts={hideShareCounts}
            hideReplyCounts={hideReplyCounts}
            hideSaveCounts={hideSaveCounts}
        />
    );
};

export default PostActionsWithNotifications;
