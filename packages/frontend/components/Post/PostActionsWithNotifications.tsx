import React from 'react';
import PostActions from './PostActions';
import { useNotificationActions } from '../../hooks/useNotificationActions';
import { logger } from '@/lib/logger';

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
}) => {
    const { notifyLike, notifyRepost } = useNotificationActions();

    const handleLike = async () => {
        try {
            onLike();
            if (!isLiked) {
                await notifyLike(postId, postAuthorId);
            }
        } catch (error) {
            logger.error('Error handling like with notification');
            onLike();
        }
    };

    const handleRepost = async () => {
        try {
            onRepost();
            if (!isReposted) {
                await notifyRepost(postId, postAuthorId);
            }
        } catch (error) {
            logger.error('Error handling repost with notification');
            onRepost();
        }
    };

    return (
        <PostActions
            engagement={engagement}
            isLiked={isLiked}
            isReposted={isReposted}
            isSaved={isSaved}
            onReply={onReply}
            onRepost={handleRepost}
            onLike={handleLike}
            onSave={onSave}
            onShare={onShare}
        />
    );
};

export default PostActionsWithNotifications;
