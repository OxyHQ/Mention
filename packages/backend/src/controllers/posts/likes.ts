/**
 * The like write path: `POST /posts/:id/like` and its undo. The vote itself is
 * `PostEngagementCommandService`; the notification, affinity and socket
 * fan-out that a like triggers are wired here.
 */

import { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { userPreferenceService, readInteractionSurface } from '../../services/UserPreferenceService';
import { affinityEventService } from '../../services/AffinityEventService';
import { logger } from '../../utils/logger';
import { emitPostEngagement, POST_ENGAGEMENT_EVENTS } from '../../services/postEngagementBroadcast';
import {
  EngagementPostNotFoundError,
  removeVoteCommand,
  votePostCommand,
} from '../../services/PostEngagementCommandService';

/**
 * Apply an idempotent vote command. The relationship, counters and durable
 * outbox event commit in one transaction; MTN, notifications and federation
 * are delivered asynchronously from that event.
 */
export const likePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;
    const value: 1 | -1 = req.body?.value === -1 ? -1 : 1;
    const surface = readInteractionSurface(req.body);

    logger.debug('Vote request received', {
      value,
      surface,
    });
    const result = await votePostCommand({ userId, postId, value, source: surface });

    if (result.changed && result.likeId && value === 1) {
      const postOwnerId = result.post.oxyUserId;
      if (postOwnerId) {
        void affinityEventService
          .record({
            fromUserId: userId,
            toUserId: postOwnerId,
            type: 'like',
            eventId: `like:${result.likeId}`,
          })
          .catch(() => undefined);
      }
    }

    // Learn only from a newly committed upvote. Idempotent retries and
    // downvotes must not inflate the viewer's positive preference signal.
    if (result.changed && value === 1) {
      void userPreferenceService
        .recordInteraction(userId, postId, 'like', { surface })
        .catch((error) => logger.warn('Failed to record interaction for preferences', error));
    }

    // Everyone watching this post gets the counters the transaction just wrote.
    // The two event names cover the whole vote axis: casting an upvote RAISES the
    // like count (from nothing, or by switching off a downvote), while a downvote
    // can only leave it where it was or lower it. Both counters ride along either
    // way, so a switched vote converges on one event. An unchanged vote moved
    // nothing and is not announced.
    if (result.changed) {
      emitPostEngagement({
        event: value === 1 ? POST_ENGAGEMENT_EVENTS.LIKED : POST_ENGAGEMENT_EVENTS.UNLIKED,
        postId,
        ...(result.post.oxyUserId ? { authorOxyUserId: result.post.oxyUserId } : {}),
        counts: {
          likes: result.post.statsLikesCount,
          downvotes: result.post.statsDownvotesCount,
        },
        actorId: userId,
      });
    }

    res.json({
      message: result.changed
        ? result.previousValue === null
          ? value === 1 ? 'Post liked successfully' : 'Post downvoted successfully'
          : 'Vote switched successfully'
        : 'Vote unchanged',
      likesCount: result.post.statsLikesCount,
      downvotesCount: result.post.statsDownvotesCount,
      liked: value === 1,
      downvoted: value === -1
    });
  } catch (error) {
    if (error instanceof EngagementPostNotFoundError) {
      return res.status(404).json({ message: 'Post not found' });
    }
    logger.error('Error voting on post', error);
    res.status(500).json({ message: 'Error voting on post' });
  }
};

// Remove vote (unlike or remove downvote)
export const unlikePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const postId = req.params.id as string;
    const result = await removeVoteCommand({ userId, postId });

    if (result.changed) {
      emitPostEngagement({
        event: POST_ENGAGEMENT_EVENTS.UNLIKED,
        postId,
        ...(result.post.oxyUserId ? { authorOxyUserId: result.post.oxyUserId } : {}),
        counts: {
          likes: result.post.statsLikesCount,
          downvotes: result.post.statsDownvotesCount,
        },
        actorId: userId,
      });
    }

    res.json({
      message: result.changed ? 'Vote removed successfully' : 'No vote to remove',
      likesCount: result.post.statsLikesCount,
      downvotesCount: result.post.statsDownvotesCount,
      liked: false,
      downvoted: false
    });
  } catch (error) {
    if (error instanceof EngagementPostNotFoundError) {
      return res.status(404).json({ message: 'Post not found' });
    }
    logger.error('Error removing vote', error);
    res.status(500).json({ message: 'Error removing vote' });
  }
};
