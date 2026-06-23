import { Post, IPost, PostFederationData, POST_CLASSIFICATION_PENDING } from '../models/Post';
import { PostType, PostVisibility, PostContent, MediaItem } from '@mention/shared-types';
import {
  createNotification,
  createMentionNotifications,
  createBatchNotifications,
} from '../utils/notificationUtils';
import PostSubscription from '../models/PostSubscription';
import { logger } from '../utils/logger';
import { getPostFederator, registerPostCreator } from './serviceRegistry';
import { baselineContentClassifier } from './BaselineContentClassifier';

export interface CreatePostParams {
  oxyUserId: string | null;
  content: PostContent;
  visibility?: PostVisibility;
  parentPostId?: string | null;
  threadId?: string | null;
  quoteOf?: string | null;
  boostOf?: string | null;
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
  // Stage-A baseline classification inputs for federated posts. The federation
  // ingest paths pass the AP-derived instance host so the deterministic
  // classifier can resolve a coarse region. (Language is threaded through the
  // existing `language` param so it also fixes the top-level `post.language`.)
  instanceDomain?: string;
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
  if (params.boostOf) return PostType.BOOST;
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
   * Compute the deterministic Stage-A classification subdoc for a post and merge
   * it onto the post data, keeping `status: 'pending'` so the async AI batch
   * (PostClassificationService) still enriches the post afterward.
   *
   * Best-effort and non-fatal: classification MUST NEVER block or fail post
   * creation. The classifier is pure/synchronous so it should not throw, but any
   * throw is caught + logged at warn and the post is still saved with the default
   * `pending` subdoc untouched.
   */
  private applyBaselineClassification(postData: Record<string, unknown>, params: CreatePostParams): void {
    try {
      const isFederated = params.federation != null;
      const metadataSensitive = (params.metadata as { isSensitive?: boolean } | undefined)?.isSensitive;
      const signals = baselineContentClassifier.classify({
        text: params.content.text,
        hashtags: params.hashtags,
        language: params.language,
        sensitive: params.federation?.sensitive ?? metadataSensitive,
        isFederated,
        instanceDomain: params.instanceDomain,
      });

      // Populate the Stage-A deterministic fields but LEAVE status 'pending' so
      // the AI batch's unclassified filter still picks the post up.
      postData.postClassification = {
        status: POST_CLASSIFICATION_PENDING,
        attempts: 0,
        topics: signals.topics,
        language: signals.language,
        region: signals.region,
        hashtagsNorm: signals.hashtagsNorm,
        sensitive: signals.sensitive,
        version: signals.version,
        classifiedAt: new Date(signals.classifiedAt),
      };
    } catch (error) {
      // Never block creation on classification — fall back to the schema default
      // (`{ status: 'pending' }`) so the AI batch still processes the post.
      logger.warn('PostCreationService: baseline classification failed; saving without Stage-A signals', error);
    }
  }

  /**
   * Create a Post document and run the standard side-effect pipeline:
   * mention notifications, reply/quote/boost notifications, subscriber
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
      boostOf: params.boostOf ?? null,
      parentPostId: params.parentPostId ?? null,
      threadId: params.threadId ?? null,
      replyPermission: params.replyPermission ?? ['anyone'],
      reviewReplies: params.reviewReplies ?? false,
      quotesDisabled: params.quotesDisabled ?? false,
      status: params.status ?? 'published',
      metadata: params.metadata ?? {},
      stats: {
        likesCount: 0,
        boostsCount: 0,
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

    // Stage-A deterministic classification (native + single-federated paths).
    // Best-effort: keeps `status: 'pending'` so the AI batch still enriches it.
    this.applyBaselineClassification(postData, params);

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
      // Reply / quote / boost notifications
      (async () => {
        if (!oxyUserId) return;
        const replyParentId = params.parentPostId ?? null;
        const idsToFetch = [replyParentId, params.quoteOf, params.boostOf].filter(
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

        if (params.boostOf) {
          const original = postsMap.get(params.boostOf);
          const recipientId = original?.oxyUserId?.toString() ?? null;
          if (recipientId && recipientId !== oxyUserId) {
            await createNotification({
              recipientId,
              actorId: oxyUserId,
              type: 'boost',
              entityId: String(original?._id),
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
        const io = global.io;
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
        // Late-bound accessor avoids a circular import with FederationService.
        await getPostFederator().federateNewPost(post, oxyUserId, params.senderUsername);
      } catch (fedError) {
        logger.error('PostCreationService: failed to federate post', fedError);
      }
    }

    return post;
  }
}

export const postCreationService = new PostCreationService();
// Register with the late-bound service registry so FederationService can create
// posts from federated notes/boosts without a circular import. See serviceRegistry.ts.
registerPostCreator(postCreationService);
