import React from 'react';
import PostActions from './PostActions';
import { useNotificationActions } from '../../hooks/useNotificationActions';
import { logger } from '@/lib/logger';

interface Engagement {
    replies: number;
    boosts: number;
    likes: number;
}

interface Props {
    engagement: Engagement;
    isLiked?: boolean;
    isBoosted?: boolean;
    isSaved?: boolean;
    postId: string;
    postAuthorId: string;
    onReply: () => void;
    onBoost: () => void;
    onLike: () => void;
    onSave: () => void;
    onShare: () => void;
}

const PostActionsWithNotifications: React.FC<Props> = ({
    engagement,
    isLiked,
    isBoosted,
    isSaved,
    postId,
    postAuthorId,
    onReply,
    onBoost,
    onLike,
    onSave,
    onShare,
}) => {
    const { notifyLike, notifyBoost } = useNotificationActions();

    const handleLike = async () => {
        onLike();
        try {
            if (!isLiked) {
                await notifyLike(postId, postAuthorId);
            }
        } catch (error) {
            logger.error('Error sending like notification');
        }
    };

    const handleBoost = async () => {
        onBoost();
        try {
            if (!isBoosted) {
                await notifyBoost(postId, postAuthorId);
            }
        } catch (error) {
            logger.error('Error sending boost notification');
        }
    };

    return (
        <PostActions
            engagement={engagement}
            isLiked={isLiked}
            isBoosted={isBoosted}
            isSaved={isSaved}
            onReply={onReply}
            onBoost={handleBoost}
            onLike={handleLike}
            onSave={onSave}
            onShare={onShare}
        />
    );
};

export default PostActionsWithNotifications;
