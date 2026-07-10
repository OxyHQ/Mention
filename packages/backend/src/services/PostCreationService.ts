import { Post, IPost, PostFederationData, POST_CLASSIFICATION_PENDING } from '../models/Post';
import { PostType, PostVisibility, PostContent, MediaItem } from '@mention/shared-types';
import {
  createNotification,
  createMentionNotifications,
  createBatchNotifications,
  createPostAuthorNotifications,
} from '../utils/notificationUtils';
import PostSubscription from '../models/PostSubscription';
import { logger } from '../utils/logger';
import { getPostFederator, registerPostCreator } from './serviceRegistry';
import { baselineContentClassifier } from './BaselineContentClassifier';
import { postHydrationService } from './PostHydrationService';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { emitPostCreated, emitRepostCreated } from './mtn/MentionRecordEmitter';
import type { ReplyContext } from './mtn/mentionRecordBuilders';
import { postCollaborationService } from './PostCollaborationService';
import { getOwnerId, hasPendingCollabInvites } from '../utils/postAuthorship';
import { mediaMetadataService } from './MediaMetadataService';
import { enqueueMediaMetadataEnrich } from './mediaMetadataEnrichJob';
import { warmLinkPreviewForTextDetached } from '../utils/linkPreviewWarm';

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
  // Full declared language set for federated posts (AP top-level `language` +
  // every `contentMap` key, via `extractApLanguages`). Authoritative for the
  // Stage-A classifier's `postClassification.languages`; the top-level
  // `post.language` continues to use the singular `language` param.
  languages?: string[];
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
  /** Local Oxy user ids to invite as collaborators (max 5). */
  collaboratorIds?: string[];
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
        languages: params.languages,
        sensitive: params.federation?.sensitive ?? metadataSensitive,
        isFederated,
        instanceDomain: params.instanceDomain,
      });

      // Populate the Stage-A deterministic fields but LEAVE status 'pending' so
      // the AI batch's unclassified filter still picks the post up. The
      // deterministic `scores` are written so ranking can downrank spam/low-quality
      // posts before any AI runs; the AI batch OVERWRITES `scores` wholesale when a
      // key is configured (the intended hybrid). The classification subdoc carries
      // ONLY the multi-language `languages` array — there is no single-value field.
      postData.postClassification = {
        status: POST_CLASSIFICATION_PENDING,
        attempts: 0,
        topics: signals.topics,
        languages: signals.languages,
        region: signals.region,
        hashtagsNorm: signals.hashtagsNorm,
        sensitive: signals.sensitive,
        scores: signals.scores,
        version: signals.version,
        classifiedAt: new Date(signals.classifiedAt),
      };

      // Keep the top-level AP `post.language` (single, protocol-facing) in sync
      // with the resolved primary (`languages[0]`, already normalized to ISO
      // 639-1). When the classifier could not resolve any language, the raw
      // `params.language` set earlier (if any) is left untouched.
      const primaryLanguage = signals.languages[0];
      if (primaryLanguage != null) {
        postData.language = primaryLanguage;
      }
    } catch (error) {
      // Never block creation on classification — fall back to the schema default
      // (`{ status: 'pending' }`) so the AI batch still processes the post.
      logger.warn('PostCreationService: baseline classification failed; saving without Stage-A signals', error);
    }
  }

  /**
   * MTN Protocol dual-write: emit the signed record for a just-created post.
   *
   * Boosts emit `app.mention.feed.repost`; everything else (top-level posts,
   * replies, quotes) emits `app.mention.feed.post`. For a reply, the `reply.root`
   * / `reply.parent` MTN URIs need the OWNER oxyUserId of the referenced posts,
   * resolved here with a single lean lookup. Entirely best-effort and isolated by
   * the emitter — a failure NEVER blocks creation or changes the response.
   */
  private async emitMtnRecord(post: IPost): Promise<void> {
    try {
      if (post.federation != null || !post.oxyUserId) {
        return;
      }

      if (post.boostOf) {
        const original = await Post.findById(post.boostOf).select('oxyUserId').lean();
        await emitRepostCreated(post, String(post.boostOf), original?.oxyUserId);
        return;
      }

      let reply: ReplyContext | undefined;
      if (post.parentPostId) {
        const rootId = post.threadId ?? post.parentPostId;
        const ids = [...new Set([String(post.parentPostId), String(rootId)])];
        const refs = await Post.find({ _id: { $in: ids } }).select('oxyUserId').lean();
        const ownerById = new Map(refs.map((r) => [String(r._id), r.oxyUserId]));
        const parentOwner = ownerById.get(String(post.parentPostId));
        const rootOwner = ownerById.get(String(rootId));
        if (parentOwner && rootOwner) {
          reply = {
            root: { postId: String(rootId), oxyUserId: rootOwner },
            parent: { postId: String(post.parentPostId), oxyUserId: parentOwner },
          };
        }
      }

      await emitPostCreated(post, { reply });
    } catch (error) {
      // Defensive: the emitter already isolates failures, but guard the resolve
      // step too so the dual-write can never surface as a creation error.
      logger.error('PostCreationService: MTN record emission failed', error);
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

    let content = params.content;
    if (Array.isArray(content.media) && content.media.length > 0) {
      const enrichedMedia = await mediaMetadataService.enrichFromOxy(content.media as MediaItem[]);
      content = { ...content, media: enrichedMedia };
    }

    const postData: Record<string, unknown> = {
      type: derivePostType({ ...params, content }),
      content,
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
      const collaboratorIds = params.collaboratorIds ?? [];
      if (collaboratorIds.length > 0 && params.oxyUserId) {
        const validated = await postCollaborationService.validateInvites(params.oxyUserId, collaboratorIds);
        postData.authorship = postCollaborationService.buildAuthorship(params.oxyUserId, validated);
        postData.metadata = { ...(postData.metadata as Record<string, unknown>), collabFederationDeferred: true };
      } else {
        postData.authorship = postCollaborationService.buildAuthorship(params.oxyUserId, []);
      }
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

    const savedMedia = post.content?.media;
    if (Array.isArray(savedMedia) && mediaMetadataService.needsOxyRetry(savedMedia as MediaItem[])) {
      void enqueueMediaMetadataEnrich(String(post._id));
    }

    const isPublished = (post.status ?? 'published') === 'published';
    const hasPendingInvites = hasPendingCollabInvites(post.authorship ?? []);

    // Collaboration invites: notify pending collaborators, but ONLY once the post
    // is actually published. A scheduled (or draft) post defers its invites until
    // it goes live — the scheduler calls publishScheduledPost, which sends them.
    if (isPublished && hasPendingInvites && params.oxyUserId) {
      await postCollaborationService.createCollabInviteNotifications(post, params.oxyUserId);
    }

    // Federation is deferred while ANY collaborator invite is still pending — the
    // post fans out to the fediverse only after every collaborator has resolved
    // their invite (accepted/declined), so an invitee is never leaked before
    // consenting. `PostCollaborationService.accept` triggers the deferred
    // federation once the last invite resolves.
    const skipFederation = params.skipFederationDelivery || hasPendingInvites;

    // MTN Protocol dual-write (best-effort, never blocks, never changes output).
    // Mongo is authoritative; this emits a signed `app.mention.feed.*` record for
    // LOCAL authors only (`federation == null && oxyUserId`). A scheduled post is
    // not yet published, so it emits when the scheduler publishes it, not here.
    if (!isScheduled) {
      await this.emitMtnRecord(post);
    }

    if (isScheduled || params.skipNotifications) {
      if (isPublished) {
        warmLinkPreviewForTextDetached(content.text);
      }
      return post;
    }

    if (isPublished) {
      warmLinkPreviewForTextDetached(content.text);
    }

    await this.runPostSideEffects(post, {
      oxyUserId: params.oxyUserId ?? null,
      senderUsername: params.senderUsername,
      skipSocketEmit: params.skipSocketEmit,
      skipFederation,
    });

    return post;
  }

  /**
   * Publish a post that was created with `status: 'scheduled'` once its
   * `scheduledFor` time has arrived. Flips the status to `published`, then runs
   * the SAME publish pipeline a fresh published post runs in `create()`:
   * collaborator invites, the MTN dual-write, notifications, the real-time feed
   * emit, and (deferred until every collaborator has resolved) federation.
   *
   * Driven by {@link ScheduledPostPublisher} (leader-gated). Every side effect
   * is isolated so one stage's failure never aborts the others; the caller
   * further isolates each post so one post never sinks the batch.
   */
  async publishScheduledPost(post: IPost): Promise<IPost> {
    post.status = 'published';
    await post.save();

    const ownerId = getOwnerId(post.authorship ?? []) ?? null;
    const hasPendingInvites = hasPendingCollabInvites(post.authorship ?? []);

    if (ownerId && hasPendingInvites) {
      await postCollaborationService.createCollabInviteNotifications(post, ownerId);
    }

    // MTN dual-write now — the signed record's authoritative timestamp is the
    // publish moment, not the (earlier) scheduling moment.
    await this.emitMtnRecord(post);

    // Resolve the owner's username so federation can build the actor. Deferred
    // (skipped) while any collaborator invite is still pending, mirroring
    // create(); the eventual accept() federates the post.
    let senderUsername: string | undefined;
    if (ownerId && !hasPendingInvites) {
      try {
        const owner = await getServiceOxyClient().getUserById(ownerId);
        senderUsername = owner.username;
      } catch (error) {
        logger.warn('PostCreationService: failed to resolve owner username for scheduled publish', error);
      }
    }

    await this.runPostSideEffects(post, {
      oxyUserId: ownerId,
      senderUsername,
      skipFederation: hasPendingInvites,
    });

    return post;
  }

  /**
   * Run the publish-time side-effect pipeline for a post that is now live:
   * mention / reply / quote / boost / subscriber notifications, the real-time
   * feed socket emit, and outbound ActivityPub federation delivery.
   *
   * Reads everything it needs from the persisted `post` document (mentions,
   * parent/quote/boost refs, visibility, status) so it can be driven both by
   * `create()` (a fresh publish) and by `publishScheduledPost()` (a previously
   * scheduled post going live). Every stage is isolated — a failure in one never
   * aborts the others or surfaces to the caller.
   */
  private async runPostSideEffects(
    post: IPost,
    ctx: {
      oxyUserId: string | null;
      senderUsername?: string;
      skipSocketEmit?: boolean;
      skipFederation: boolean;
    },
  ): Promise<void> {
    const oxyUserId = ctx.oxyUserId;
    const mentions = post.mentions ?? [];
    const parentPostId = post.parentPostId ?? null;
    const quoteOf = post.quoteOf ?? null;
    const boostOf = post.boostOf ?? null;

    // Run all notification stages in parallel — they are independent
    const results = await Promise.allSettled([
      // Mention notifications
      (async () => {
        if (oxyUserId && mentions.length > 0) {
          const isReply = Boolean(parentPostId);
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
        const idsToFetch = [parentPostId, quoteOf, boostOf].filter(
          (id): id is string => Boolean(id),
        );
        if (idsToFetch.length === 0) return;

        const relatedPosts = await Post.find({ _id: { $in: idsToFetch } })
          .select('oxyUserId authorship')
          .lean();
        const postsMap = new Map(relatedPosts.map((p) => [String(p._id), p]));

        if (parentPostId) {
          const parent = postsMap.get(String(parentPostId));
          if (parent) {
            await createPostAuthorNotifications(
              parent.authorship as import('@mention/shared-types').PostAuthorshipEntry[] | undefined,
              {
                actorId: oxyUserId,
                type: 'reply',
                entityId: String(post._id),
                entityType: 'reply',
              },
            );
          }
        }

        if (quoteOf) {
          const original = postsMap.get(String(quoteOf));
          if (original) {
            await createPostAuthorNotifications(
              original.authorship as import('@mention/shared-types').PostAuthorshipEntry[] | undefined,
              {
                actorId: oxyUserId,
                type: 'quote',
                entityId: String(original._id),
                entityType: 'post',
              },
            );
          }
        }

        if (boostOf) {
          const original = postsMap.get(String(boostOf));
          if (original) {
            await createPostAuthorNotifications(
              original.authorship as import('@mention/shared-types').PostAuthorshipEntry[] | undefined,
              {
                actorId: oxyUserId,
                type: 'boost',
                entityId: String(original._id),
                entityType: 'post',
              },
            );
          }
        }
      })(),
      // Subscriber notifications (top-level posts only)
      (async () => {
        const isTopLevelPost = !parentPostId;
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

    const isPublished = (post.status ?? 'published') === 'published';

    const shouldEmitGlobally = post.visibility === 'public' && isPublished;
    if (!ctx.skipSocketEmit && shouldEmitGlobally) {
      try {
        const io = global.io;
        if (io) {
          // Emit the canonical hydrated DTO (author summary, resolved
          // name.displayName, engagement shape, and embedded boosted original)
          // so the post renders correctly in real time instead of as a raw,
          // unhydrated document. Mirrors createThread's post-create emit.
          // maxDepth:1 is REQUIRED so a created boost embeds its boostOf target
          // (a boost has an intentionally empty body and renders blank otherwise).
          const [hydratedPost] = await postHydrationService.hydratePosts([post.toObject()], {
            // This DTO is broadcast to all sockets, so hydrate as an anonymous
            // viewer. Nested quote/boost references that are not publicly
            // visible are omitted instead of leaking via a creator-specific ACL.
            viewerId: undefined,
            oxyClient: getServiceOxyClient(),
            maxDepth: 1,
            includeLinkMetadata: true,
          });
          if (hydratedPost) {
            io.emit('feed:updated', {
              type: 'for_you',
              post: hydratedPost,
              timestamp: new Date().toISOString(),
            });
            io.emit('feed:updated', {
              type: 'following',
              post: hydratedPost,
              authorId: oxyUserId,
              timestamp: new Date().toISOString(),
            });
          }
        }
      } catch (socketError) {
        logger.warn('PostCreationService: failed to emit socket event', socketError);
      }
    }

    // Federation is published-only: a draft never fans out even if a username is
    // resolvable, and the collab-pending gate is honored via `ctx.skipFederation`.
    if (!ctx.skipFederation && isPublished && oxyUserId && ctx.senderUsername) {
      try {
        // Late-bound accessor avoids a circular import with the connector registry.
        await getPostFederator().federateNewPost(post, oxyUserId, ctx.senderUsername);
        post.metadata = { ...(post.metadata ?? {}), federationDelivered: true };
        post.markModified('metadata');
        await post.save();
      } catch (fedError) {
        logger.error('PostCreationService: failed to federate post', fedError);
      }
    }
  }
}

export const postCreationService = new PostCreationService();
// Register with the late-bound service registry so the network connectors can
// create posts from federated notes/boosts without a circular import. See
// serviceRegistry.ts.
registerPostCreator(postCreationService);
