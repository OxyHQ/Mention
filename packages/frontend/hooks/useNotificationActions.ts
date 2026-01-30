import { useCallback } from 'react';
import { useAuth } from '@oxyhq/services';
import { notificationCreationService } from '../services/notificationCreationService';

/**
 * Hook for creating notifications when user actions occur
 * This should be used in components that perform actions that should notify other users
 */
export const useNotificationActions = () => {
  const { user } = useAuth();

  const notifyLike = useCallback(async (postId: string, postAuthorId: string) => {
    if (!user?.id) return;
    await notificationCreationService.notifyLike(postId, postAuthorId, user.id);
  }, [user?.id]);

  const notifyReply = useCallback(async (postId: string, postAuthorId: string, replyId: string) => {
    if (!user?.id) return;
    await notificationCreationService.notifyReply(postId, postAuthorId, user.id, replyId);
  }, [user?.id]);

  const notifyRepost = useCallback(async (postId: string, postAuthorId: string) => {
    if (!user?.id) return;
    await notificationCreationService.notifyRepost(postId, postAuthorId, user.id);
  }, [user?.id]);

  const notifyFollow = useCallback(async (followedUserId: string) => {
    if (!user?.id) return;
    await notificationCreationService.notifyFollow(followedUserId, user.id);
  }, [user?.id]);

  const notifyMentions = useCallback(async (content: string, postId: string) => {
    if (!user?.id) return;
    await notificationCreationService.notifyMentions(content, postId, user.id);
  }, [user?.id]);

  const notifyQuote = useCallback(async (originalPostId: string, originalAuthorId: string, quoteId: string) => {
    if (!user?.id) return;
    await notificationCreationService.notifyQuote(originalPostId, originalAuthorId, user.id, quoteId);
  }, [user?.id]);

  return {
    notifyLike,
    notifyReply,
    notifyRepost,
    notifyFollow,
    notifyMentions,
    notifyQuote,
  };
};
