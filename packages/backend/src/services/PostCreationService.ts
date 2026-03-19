import { Post, IPost, PostFederationData } from '../models/Post';
import { PostType, PostVisibility, PostContent, MediaItem } from '@mention/shared-types';
import {
  createNotification,
  createMentionNotifications,
  createBatchNotifications,
} from '../utils/notificationUtils';
import PostSubscription from '../models/PostSubscription';
import { logger } from '../utils/logger';

export interface CreatePostParams {
  oxyUserId?: string | null;
  content: PostContent;
  visibility?: PostVisibility;
  parentPostId?: string | null;
  threadId?: string | null;
  quoteOf?: string | null;
  repostOf?: string | null;
  hashtags?: string[];
  mentions?: string[];
  language?: string;
  location?: {
    type: 'Point';
    coordinates: [number, number];
    address?: string;
  } | null;
  status?: 'draft' | 'published' | 'scheduled';
  scheduledFor?: Date;
  replyPermission?: string[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  metadata?: Record<string, unknown>;
  // Federation fields — only for incoming federated posts
  federation?: PostFederationData;
  // Caller-supplied username enables outbound ActivityPub federation delivery.
  // When omitted, federation delivery is skipped.
  senderUsername?: string;
  // Pipeline control flags
  skipNotifications?: boolean;
  skipSocketEmit?: boolean;
  skipFederationDelivery?: boolean;
  // Override timestamps for federated posts with original publish dates
  createdAt?: Date;
  updatedAt?: Date;
}

function derivePostType(params: CreatePostParams): PostType {
  if (params.repostOf) return PostType.REPOST;
  if (params.quoteOf) return PostType.QUOTE;
  const media = params.content.media;
  if (Array.isArray(media) && media.length > 0) {
    const hasVideo = (media as MediaItem[]).some((m) => m.type === 'video');
    return hasVideo ? PostType.VIDEO : PostType.IMAGE;
  }
  return PostType.TEXT;
}

class PostCreationService {
  /**
   * Create a Post document and run the standard side-effect pipeline:
   * mention notifications, reply/quote/repost notifications, subscriber
   * notifications, socket emission, and federation delivery.
   *
   * Pass `skipNotifications`, `skipSocketEmit`, or `skipFederationDelivery`
   * to suppress individual stages (e.g. for incoming federated posts).
   */
  async create(params: CreatePostParams): Promise<IPost> {
    const isScheduled = params.status === 'scheduled';

    const postData: Record<string, unknown> = {
      type: derivePostType(params),
      content: params.content,
      visibility: params.visibility ?? PostVisibility.PUBLIC,
      hashtags: params.hashtags ?? [],
      mentions: params.mentions ?? [],
      quoteOf: params.quoteOf ?? null,
      repostOf: params.repostOf ?? null,
      parentPostId: params.parentPostId ?? null,
      threadId: params.threadId ?? null,
      replyPermission: params.replyPermission ?? ['anyone'],
      reviewReplies: params.reviewReplies ?? false,
      quotesDisabled: params.quotesDisabled ?? false,
      status: params.status ?? 'published',
      metadata: params.metadata ?? {},
      stats: {
        likesCount: 0,
        repostsCount: 0,
        commentsCount: 0,
        viewsCount: 0,
        sharesCount: 0,
      },
    };

    if (params.oxyUserId != null) {
      postData.oxyUserId = params.oxyUserId;
    }
    if (params.federation != null) {
      postData.federation = params.federation;
    }
    if (params.location != null) {
      postData.location = params.location;
    }
    if (params.language != null) {
      postData.language = params.language;
    }
    if (params.scheduledFor != null) {
      postData.scheduledFor = params.scheduledFor;
    }
    if (params.createdAt != null) {
      postData.createdAt = params.createdAt;
    }
    if (params.updatedAt != null) {
      postData.updatedAt = params.updatedAt;
    }

    const post = new Post(postData);
    await post.save();

    if (isScheduled || params.skipNotifications) {
      return post;
    }

    const oxyUserId = params.oxyUserId ?? null;

    // Run all notification stages in parallel — they are independent
    const results = await Promise.allSettled([
      // Mention notifications
      (async () => {
        const mentions = params.mentions ?? [];
        if (oxyUserId && mentions.length > 0) {
          const isReply = Boolean(params.parentPostId);
          await createMentionNotifications(
            mentions,
            String(post._id),
            oxyUserId,
            isReply ? 'reply' : 'post',
          );
        }
      })(),
      // Reply / quote / repost notifications
      (async () => {
        if (!oxyUserId) return;
        const replyParentId = params.parentPostId ?? null;
        const idsToFetch = [replyParentId, params.quoteOf, params.repostOf].filter(
          (id): id is string => Boolean(id),
        );
        if (idsToFetch.length === 0) return;

        const relatedPosts = await Post.find({ _id: { $in: idsToFetch } })
          .select('oxyUserId')
          .lean();
        const postsMap = new Map(relatedPosts.map((p) => [String(p._id), p]));

        if (replyParentId) {
          const parent = postsMap.get(replyParentId);
          const recipientId = parent?.oxyUserId?.toString() ?? null;
          if (recipientId && recipientId !== oxyUserId) {
            await createNotification({
              recipientId,
              actorId: oxyUserId,
              type: 'reply',
              entityId: String(post._id),
              entityType: 'reply',
            });
          }
        }

        if (params.quoteOf) {
          const original = postsMap.get(params.quoteOf);
          const recipientId = original?.oxyUserId?.toString() ?? null;
          if (recipientId && recipientId !== oxyUserId) {
            await createNotification({
              recipientId,
              actorId: oxyUserId,
              type: 'quote',
              entityId: String(original!._id),
              entityType: 'post',
            });
          }
        }

        if (params.repostOf) {
          const original = postsMap.get(params.repostOf);
          const recipientId = original?.oxyUserId?.toString() ?? null;
          if (recipientId && recipientId !== oxyUserId) {
            await createNotification({
              recipientId,
              actorId: oxyUserId,
              type: 'repost',
              entityId: String(original!._id),
              entityType: 'post',
            });
          }
        }
      })(),
      // Subscriber notifications (top-level posts only)
      (async () => {
        const isTopLevelPost = !params.parentPostId;
        if (!oxyUserId || !isTopLevelPost) return;
        const subs = await PostSubscription.find({ authorId: oxyUserId }).lean();
        if (subs.length === 0) return;
        const notifications = subs
          .filter((s) => s.subscriberId !== oxyUserId)
          .map((s) => ({
            recipientId: s.subscriberId,
            actorId: oxyUserId,
            type: 'post' as const,
            entityId: String(post._id),
            entityType: 'post' as const,
          }));
        if (notifications.length > 0) {
          await createBatchNotifications(notifications, true);
        }
      })(),
    ]);

    for (const r of results) {
      if (r.status === 'rejected') {
        logger.error('PostCreationService: notification stage failed', r.reason);
      }
    }

    if (!params.skipSocketEmit) {
      try {
        const io = (global as { io?: { emit: (event: string, data: unknown) => void } }).io;
        if (io) {
          const postObj = { ...post.toObject(), id: String(post._id) };
          io.emit('feed:updated', {
            type: 'for_you',
            post: postObj,
            timestamp: new Date().toISOString(),
          });
          io.emit('feed:updated', {
            type: 'following',
            post: postObj,
            authorId: oxyUserId,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (socketError) {
        logger.warn('PostCreationService: failed to emit socket event', socketError);
      }
    }

    if (!params.skipFederationDelivery && oxyUserId && params.senderUsername) {
      try {
        // Lazy require avoids a circular dependency with FederationService
        const { federationService } = require('./FederationService') as {
          federationService: {
            federateNewPost: (
              post: {
                _id: unknown;
                content: { text?: string };
                hashtags?: string[];
                mentions?: string[];
                visibility: string;
                createdAt: string;
              },
              senderOxyUserId: string,
              senderUsername: string,
            ) => Promise<void>;
          };
        };
        await federationService.federateNewPost(post, oxyUserId, params.senderUsername);
      } catch (fedError) {
        logger.error('PostCreationService: failed to federate post', fedError);
      }
    }

    return post;
  }
}

export const postCreationService = new PostCreationService();
