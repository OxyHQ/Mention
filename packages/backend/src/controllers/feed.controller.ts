import { Response } from 'express';
import { Post, POST_CLASSIFICATION_PENDING } from '../models/Post';
import Block from '../models/Block';
import Mute from '../models/Mute';
import {
  CreateReplyRequest,
  CreateBoostRequest,
  PostType,
  PostVisibility,
  PostContent,
  HydratedPost,
} from '@mention/shared-types';
import mongoose, { FilterQuery } from 'mongoose';
import { IPost } from '../models/Post';
import { io } from '../../server';
import { oxy as oxyClient } from '../../server';
import { userPreferenceService, readInteractionSurface } from '../services/UserPreferenceService';
import { affinityEventService } from '../services/AffinityEventService';
import { postHydrationService } from '../services/PostHydrationService';
import UserSettings from '../models/UserSettings';
import { checkFollowAccess, extractFollowingIds, requiresAccessCheck, ProfileVisibility, OxyClient } from '../utils/privacyHelpers';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { logger } from '../utils/logger';
import {
  validateAndNormalizeLimit,
  parseFeedCursor,
  FEED_CONSTANTS
} from '../utils/feedUtils';
import { mergeHashtags } from '../utils/textProcessing';
import { normalizeMediaItems } from '../utils/mediaInput';
import { queryString } from '../utils/queryParams';
import { buildAuthorship } from '../utils/postAuthorship';
import { validatePublicShareTarget } from '../utils/postAccessControl';
import { baselineContentClassifier } from '../services/BaselineContentClassifier';
import { createScopedOxyClient, getServiceOxyClient } from '../utils/oxyHelpers';
import { connectorRegistry } from '../connectors';
import type { LocalNetworkEvent } from '../connectors/types';
import {
  emitPostCreated,
  emitRepostCreated,
  emitTombstone,
  repostRecordUri,
} from '../services/mtn/MentionRecordEmitter';
import { sanitizePodcast, resolvePodcastContent } from '../utils/syraPodcast';

/**
 * Hard cap on how many posts of an author's self-thread continuation spine the
 * post-detail thread view returns. Threads are short in practice (a handful of
 * continuations); this is a safety ceiling mirroring the frontend ancestor walk
 * guard (MAX_ANCESTOR_DEPTH), guarding against a runaway thread.
 */
const MAX_THREAD_CONTINUATION_DEPTH = 50;

/**
 * A follower/mention reference may arrive as a bare user-id string or as a
 * populated object carrying `id`/`_id`. Used when checking reply permissions.
 */
type FollowerRef = string | { id?: string; _id?: string };

/**
 * Feed Controller
 *
 * Replies, thread continuations, the pinned post, and the reply/boost write
 * paths. The profile feed itself is served by the MTN engine
 * (`author|<oxyUserId>|<tab>`), not from here.
 *
 * @class FeedController
 */
class FeedController {
  /** Optimized field selection for feed queries - reduces data transfer by 60-80% */
  private readonly FEED_FIELDS = '_id oxyUserId authorship federation createdAt visibility type parentPostId boostOf quoteOf threadId content stats metadata hashtags mentions language';

  /**
   * Transform posts to include full profile data and engagement stats
   * 
   * @param posts - Raw post documents from database
   * @param currentUserId - Current user ID for personalization
   * @returns Array of hydrated posts with user data and engagement stats
   */
  // Public because the list-timeline route (`routes/lists.ts`) reuses the same
  // hydration path as the controller's own feed endpoints.
  async transformPostsWithProfiles(posts: object[], currentUserId?: string, oxyClient?: OxyClient): Promise<HydratedPost[]> {
    try {
      if (!posts || posts.length === 0) {
        return [];
      }

      // Optimized hydration for feed items: maxDepth 0 (no nested posts) for better performance
      // Feed items don't need nested context - only detail views need depth 1
      const hydrated = await postHydrationService.hydratePosts(posts, {
        viewerId: currentUserId,
        oxyClient,
        maxDepth: 0, // Reduced from 1 for feed performance - saves ~30-50ms per request
        includeLinkMetadata: true,
        includeFullArticleBody: false, // Don't include article bodies in feed
        includeFullMetadata: false, // Skip some metadata fields for performance
      });
      
      // Ensure all posts have required fields
      return hydrated.filter((post) => {
        if (!post || !post.id) {
          logger.warn('[Feed] Filtered out post without id', post);
          return false;
        }
        if (!post.user || !post.user.id) {
          logger.warn('[Feed] Filtered out post without user', post.id);
          return false;
        }
        return true;
      });
    } catch (error) {
      logger.error('[Feed] Error transforming posts', error);
      // Return empty array instead of throwing to prevent feed from breaking
      return [];
    }
  }

  /**
   * Get list of blocked and muted user IDs for filtering
   *
   * @param userId - Current user ID
   * @returns Array of user IDs to filter out
   */
  private async getBlockedAndMutedUserIds(userId?: string): Promise<string[]> {
    if (!userId) return [];

    try {
      const [blockedUsers, mutedUsers] = await Promise.all([
        Block.find({ userId }).select('blockedId').lean(),
        Mute.find({ userId }).select('mutedId').lean()
      ]);

      const blockedIds = blockedUsers.map(b => b.blockedId);
      const mutedIds = mutedUsers.map(m => m.mutedId);

      // Combine and deduplicate
      return [...new Set([...blockedIds, ...mutedIds])];
    } catch (error) {
      logger.warn('[Feed] Failed to fetch blocked/muted users', error);
      return [];
    }
  }

  /**
   * Filter out posts from blocked and muted users
   *
   * @param posts - Array of posts to filter
   * @param blockedAndMutedIds - Array of user IDs to filter out
   * @returns Filtered posts array
   */
  private filterBlockedAndMutedPosts<T extends { oxyUserId?: unknown }>(posts: T[], blockedAndMutedIds: string[]): T[] {
    if (blockedAndMutedIds.length === 0) return posts;

    return posts.filter(post => {
      const authorId = post.oxyUserId == null ? '' : String(post.oxyUserId);
      return !blockedAndMutedIds.includes(authorId);
    });
  }

  /**
   * Fire-and-forget outbound federation for a local interaction, through the
   * connector seam (which applies the per-user `fediverseSharing` gate; the
   * connector re-checks it too).
   *
   * The acting user's username is resolved SERVER-SIDE from the authoritative
   * `oxyUserId`: the Oxy auth middleware runs without `loadUser`, so
   * `req.user.username` is never populated and must not be trusted. Once resolved,
   * `buildEvent(username)` produces the concrete `LocalNetworkEvent`. Never blocks
   * or fails the HTTP response — a resolve miss is logged and skipped, any error
   * is caught.
   */
  private federateAsResolvedActor(
    actorOxyUserId: string,
    context: string,
    buildEvent: (username: string) => LocalNetworkEvent,
  ): void {
    void (async () => {
      const user = await getServiceOxyClient().getUserById(actorOxyUserId);
      const username = user.username?.trim();
      if (!username) {
        logger.warn(`[Feed] skipping ${context} federation for ${actorOxyUserId}: no resolvable username`);
        return;
      }
      await connectorRegistry.deliver(buildEvent(username));
    })().catch((err) => {
      logger.error(`[Feed] failed to federate ${context}`, err);
    });
  }

  /**
   * Federate a local boost / unboost outbound as an ActivityPub
   * `Announce` / `Undo(Announce)`. The boosted ORIGINAL post is untouched by an
   * unboost, so target resolution works from `boostOf` in both directions.
   */
  private federateBoostChange(
    kind: 'post.boost' | 'post.unboost',
    boost: { _id: unknown; boostOf: string; createdAt: string | Date },
    boosterOxyUserId: string,
  ): void {
    this.federateAsResolvedActor(boosterOxyUserId, kind, (username) => ({
      kind,
      boost: { _id: boost._id, boostOf: boost.boostOf, createdAt: boost.createdAt },
      actorOxyUserId: boosterOxyUserId,
      actorUsername: username,
    }));
  }

  /**
   * Federate a local reply (the `POST /feed/reply` path) outbound as an
   * ActivityPub `Create(Note)` through the SAME `post.create` seam
   * `PostCreationService` uses — so the connector applies the reply enrichment
   * (`inReplyTo` + parent-author `Mention`, delivery to the parent author's inbox
   * for a federated parent) and the sharing/visibility gates identically to the
   * `POST /posts` reply path. Passing `parentPostId` is what routes it to the
   * reply-addressing branch of `federateNewPost`. A pending-review (private) reply
   * carries `visibility: private`, so the connector skips it.
   */
  private federateReply(reply: IPost, replierOxyUserId: string): void {
    // `createdAt` is a Mongoose timestamp (a Date at runtime, though typed as
    // string on IPost); normalize to a canonical ISO 8601 string for the wire.
    const createdAt = new Date(reply.createdAt).toISOString();
    this.federateAsResolvedActor(replierOxyUserId, 'reply', (username) => ({
      kind: 'post.create',
      post: {
        _id: reply._id,
        content: reply.content,
        hashtags: reply.hashtags,
        mentions: reply.mentions,
        visibility: reply.visibility,
        createdAt,
        parentPostId: reply.parentPostId ? String(reply.parentPostId) : null,
      },
      actorOxyUserId: replierOxyUserId,
      actorUsername: username,
    }));
  }

  /**
   * Create a reply to a post
   */
  async createReply(req: AuthRequest, res: Response) {
    try {
  const { postId, content, mentions, hashtags } = req.body as CreateReplyRequest;
  // Accept content as either a string or an object; normalize to PostContent shape
  // The persisted reply content is the OUTPUT shape: the client-supplied podcast
  // is only `{ syraPodcastId }` (input), so we drop it here and re-attach the
  // server-denormalized show below; everything else carries over.
  const replyContent: PostContent = typeof content === 'string' ? { text: content } : { ...(content ?? { text: '' }), podcast: undefined };

      // A reply carries composer media, so it is a write boundary like
      // `POST /posts`: the client's items go through the SAME normalizer
      // (whitelisted fields, canonical alt text, length cap). This path persists
      // the document itself — and signs it onto the author's MTN hash chain —
      // so an un-normalized `alt` accepted here would be immutable.
      if (Array.isArray(replyContent.media)) {
        replyContent.media = normalizeMediaItems(replyContent.media);
      }

      const currentUserId = req.user?.id;

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!content || !postId) {
        return res.status(400).json({ error: 'Content and post ID are required' });
      }

      // Fetch parent post to check reply permissions
      const parentPost = await Post.findById(postId)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();
      if (!parentPost) {
        return res.status(404).json({ error: 'Post not found' });
      }

      // Check reply permissions
      const permissions: string[] = parentPost.replyPermission || ['anyone'];

      if (!permissions.includes('anyone')) {
        const parentAuthorId = parentPost.oxyUserId ? String(parentPost.oxyUserId) : undefined;

        // If replying to own post, always allow
        if (parentAuthorId === currentUserId) {
          // Allow
        } else {
          let canReply = false;

          if (permissions.includes('nobody')) {
            canReply = false;
          } else {
            try {
              for (const perm of permissions) {
                if (canReply) break;
                switch (perm) {
                  case 'followers': {
                    if (!parentAuthorId) break;
                    const authorFollowers = await oxyClient.getUserFollowers(parentAuthorId);
                    canReply = authorFollowers?.followers?.some((f: FollowerRef) => {
                      const followerId = typeof f === 'string' ? f : (f.id || f._id);
                      return followerId === currentUserId || String(followerId) === String(currentUserId);
                    }) || false;
                    break;
                  }
                  case 'following': {
                    if (!parentAuthorId) break;
                    try {
                      const authorFollowing = await oxyClient.getUserFollowing(parentAuthorId);
                      const followingIds = extractFollowingIds(authorFollowing);
                      canReply = followingIds.includes(currentUserId);
                    } catch (error) {
                      logger.warn('Failed to check author following', error);
                    }
                    break;
                  }
                  case 'mentioned': {
                    canReply = (parentPost.mentions || []).some((m: FollowerRef) => {
                      const mentionId = typeof m === 'string' ? m : (m.id || m._id);
                      return mentionId === currentUserId || String(mentionId) === String(currentUserId);
                    });
                    break;
                  }
                }
              }
            } catch (error) {
              logger.error('Error checking reply permissions', error);
              canReply = false;
            }
          }

          if (!canReply) {
            return res.status(403).json({
              error: 'You do not have permission to reply to this post',
              replyPermission: permissions
            });
          }
        }
      }

  // Create reply post
      const mergedTags = mergeHashtags(replyContent?.text || '', hashtags);

      // A reply may attach a single Syra podcast show. Like createPost, the
      // client's reference is untrusted: re-resolve + denormalize the show
      // server-side so a reply can never persist fabricated podcast metadata. An
      // unresolvable show — or any podcast missing a usable id — is dropped.
      const replySanitizedPodcast = sanitizePodcast(typeof content === 'string' ? undefined : content?.podcast);
      if (replySanitizedPodcast) {
        try {
          replyContent.podcast = await resolvePodcastContent(replySanitizedPodcast.syraPodcastId);
        } catch (podcastError) {
          logger.warn('createReply: failed to resolve Syra podcast; dropping', { userId: currentUserId, syraPodcastId: replySanitizedPodcast.syraPodcastId, error: podcastError });
        }
      }

      // If reviewReplies is enabled, set visibility to pending or use a flag
      // For now, we'll still create it but mark it for review
      const reply = new Post({
        oxyUserId: currentUserId,
        authorship: buildAuthorship(currentUserId, []),
        type: PostType.TEXT,
        content: replyContent,
        visibility: parentPost.reviewReplies ? PostVisibility.PRIVATE : PostVisibility.PUBLIC,
        parentPostId: postId,
        threadId: parentPost.threadId || parentPost._id.toString(),
        hashtags: mergedTags,
        mentions: mentions || [],
        stats: {
          likesCount: 0,
          boostsCount: 0,
          commentsCount: 0,
          viewsCount: 0,
          sharesCount: 0
        }
      });

      // Stage-A deterministic classification. This native reply path saves the
      // doc directly (not via PostCreationService), so populate the baseline
      // fields here while keeping `status: 'pending'` so the AI batch still
      // enriches it. Best-effort: never block the reply on classification.
      try {
        const signals = baselineContentClassifier.classify({
          text: replyContent?.text,
          hashtags: mergedTags,
        });
        // `attempts` is internal bookkeeping (not on the PostClassification type);
        // the subschema default seeds it to 0 for the unset path. The subdoc
        // carries ONLY the multi-language `languages` array; the primary
        // (`languages[0]`) is written to the top-level AP `post.language`.
        reply.postClassification = {
          status: POST_CLASSIFICATION_PENDING,
          topics: signals.topics,
          languages: signals.languages,
          region: signals.region,
          hashtagsNorm: signals.hashtagsNorm,
          sensitive: signals.sensitive,
          scores: signals.scores,
          version: signals.version,
          classifiedAt: new Date(signals.classifiedAt),
        };
        const primaryLanguage = signals.languages[0];
        if (primaryLanguage != null) {
          reply.language = primaryLanguage;
        }
      } catch (classifyError) {
        logger.warn('createReply: baseline classification failed; saving with default pending', classifyError);
      }

      await reply.save();

      // MTN dual-write: a reply emits an `app.mention.feed.post` record with the
      // thread position (reply.root / reply.parent). The direct parent is
      // `parentPost`; the thread root is `parentPost.threadId` (or the parent
      // itself when it IS the root). Resolve the root owner with a lean lookup
      // only when the root differs from the parent. Best-effort, never blocks.
      try {
        const rootId = parentPost.threadId ? String(parentPost.threadId) : String(parentPost._id);
        const parentOwner = parentPost.oxyUserId ? String(parentPost.oxyUserId) : undefined;
        let rootOwner = rootId === String(parentPost._id) ? parentOwner : undefined;
        if (!rootOwner && rootId) {
          const rootPost = await Post.findById(rootId).select('oxyUserId').lean();
          rootOwner = rootPost?.oxyUserId ? String(rootPost.oxyUserId) : undefined;
        }
        const replyContext =
          parentOwner && rootOwner
            ? {
                root: { postId: rootId, oxyUserId: rootOwner },
                parent: { postId: String(postId), oxyUserId: parentOwner },
              }
            : undefined;
        await emitPostCreated(reply, { reply: replyContext });
      } catch (mtnError) {
        logger.error('createReply: MTN record emission failed', mtnError);
      }

      // Affinity graph: the replier expresses affinity toward the parent post's
      // author. Fire-and-forget — buffering must never block or fail the reply.
      const parentAuthorId = parentPost.oxyUserId ? String(parentPost.oxyUserId) : undefined;
      if (parentAuthorId) {
        void affinityEventService
          .record({ fromUserId: currentUserId, toUserId: parentAuthorId, type: 'reply', eventId: `reply:${String(reply._id)}` })
          .catch(() => undefined);
      }

      // Update parent post comment count
      await Post.findByIdAndUpdate(postId, {
        $inc: { 'stats.commentsCount': 1 }
      }, { maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });

      // Outbound federation: deliver the reply as a Create(Note) with `inReplyTo`
      // + a parent-author Mention to the replier's remote followers AND (when the
      // parent is federated) the parent author's inbox — through the SAME seam the
      // `POST /posts` reply path uses. Native reply only (this endpoint never
      // creates federated posts); gated on sharing + public visibility inside the
      // connector. Fire-and-forget — never blocks the reply response.
      this.federateReply(reply, currentUserId);

      // Hydrate the created reply at maxDepth 1 so the response + socket payload
      // carry the author summary and engagement shape (and, when the reply is a
      // quote, the embedded quoted card) — matching the feed/detail DTO instead
      // of a raw `.toObject()`.
      const [hydratedReply] = await postHydrationService.hydratePosts([reply.toObject()], {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });

      // Emit real-time update to post room only (not all clients)
      io.to(`post:${postId}`).emit('post:replied', {
        postId,
        reply: hydratedReply,
        timestamp: new Date().toISOString()
      });

      res.status(201).json({
        success: true,
        reply: hydratedReply
      });
    } catch (error) {
      logger.error('Error creating reply', error);
      res.status(500).json({ 
        error: 'Failed to create reply',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Create a boost
   */
  async createBoost(req: AuthRequest, res: Response) {
    try {
      const { originalPostId, content, mentions, hashtags } = req.body as CreateBoostRequest;
      const currentUserId = req.user?.id;
      const surface = readInteractionSurface(req.body);

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!originalPostId) {
        return res.status(400).json({ error: 'Original post ID is required' });
      }

      const originalPost = await Post.findById(originalPostId)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();
      const shareValidation = validatePublicShareTarget(originalPost, { action: 'boost' });
      if (!shareValidation.ok) {
        return res.status(shareValidation.status).json({ error: shareValidation.message });
      }

      // Check if user already boosted this
      const existingBoost = await Post.findOne({
        oxyUserId: currentUserId,
        boostOf: originalPostId
      })
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS);

      if (existingBoost) {
        return res.status(400).json({ error: 'You have already boosted this content' });
      }

      // Create boost
      const mergedTags = mergeHashtags(content?.text || '', hashtags);

      const boost = new Post({
        oxyUserId: currentUserId,
        authorship: buildAuthorship(currentUserId, []),
        type: PostType.BOOST,
        content: content || { text: '' },
        visibility: PostVisibility.PUBLIC,
        boostOf: originalPostId,
        hashtags: mergedTags,
        mentions: mentions || [],
        stats: {
          likesCount: 0,
          boostsCount: 0,
          commentsCount: 0,
          viewsCount: 0,
          sharesCount: 0
        }
      });

      await boost.save();

      // MTN dual-write: a boost emits an `app.mention.feed.repost` record whose
      // subject is the boosted original's MTN URI. Best-effort, never blocks.
      await emitRepostCreated(boost, String(originalPostId), originalPost?.oxyUserId?.toString?.());

      // Outbound federation: announce the boost to the booster's remote
      // followers (and, if the original is federated, its author's instance).
      // Local booster only — a native boost has `federation == null`.
      if (boost.federation == null) {
        this.federateBoostChange(
          'post.boost',
          { _id: boost._id, boostOf: String(originalPostId), createdAt: boost.createdAt },
          currentUserId,
        );
      }

      // Affinity graph: the booster expresses affinity toward the boosted post's
      // author. Fire-and-forget — buffering must never block or fail the boost.
      const boostedAuthorId = originalPost?.oxyUserId?.toString?.();
      if (boostedAuthorId) {
        void affinityEventService
          .record({ fromUserId: currentUserId, toUserId: boostedAuthorId, type: 'boost', eventId: `boost:${String(boost._id)}` })
          .catch(() => undefined);
      }

      // Update original post boost count and get the updated count
      const updatedPost = await Post.findByIdAndUpdate(
        originalPostId,
        { $inc: { 'stats.boostsCount': 1 } },
        { new: true, maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS }
      );

      // Record interaction for user preference learning
      try {
        await userPreferenceService.recordInteraction(currentUserId, originalPostId, 'boost', { surface });
      } catch (error) {
        logger.warn('Failed to record interaction for preferences', error);
      }

      // A boost has an intentionally empty content body and relies on `boostOf`
      // for its rendered content. Hydrate at maxDepth 1 so the response + socket
      // payload carry the embedded original, the author summary, and the engagement
      // shape — matching the feed/detail DTO instead of a raw `.toObject()`.
      const [hydratedBoost] = await postHydrationService.hydratePosts([boost.toObject()], {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });

      // Emit real-time update to post room only (not all clients)
      io.to(`post:${originalPostId}`).emit('post:boosted', {
        originalPostId,
        postId: originalPostId,
        boost: hydratedBoost,
        boostsCount: updatedPost?.stats?.boostsCount,
        userId: currentUserId,
        actorId: currentUserId,
        timestamp: new Date().toISOString()
      });

      res.status(201).json({
        success: true,
        boost: hydratedBoost
      });
    } catch (error) {
      logger.error('Error creating boost', error);
      res.status(500).json({
        error: 'Failed to create boost',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Unboost a post
   */
  async unboostItem(req: AuthRequest, res: Response) {
    try {
      const postId = req.params.postId as string;
      const currentUserId = req.user?.id;

      logger.debug('🔄 Unboost request', { postId, currentUserId });

      if (!currentUserId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      if (!postId) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      // Interpret :postId as the ORIGINAL post ID for unboost operations.
      // Find and delete the boost document created by the current user that points to this original.
      const boost = await Post.findOneAndDelete({
        oxyUserId: currentUserId,
        boostOf: postId
      }, { maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });

      if (!boost) {
        return res.status(404).json({ error: 'Boost not found' });
      }

      // MTN dual-write: tombstone the boost's `app.mention.feed.repost` record.
      // Only LOCAL boosts ever emitted a record.
      if (boost.federation == null && boost.oxyUserId) {
        await emitTombstone({
          authorOxyUserId: boost.oxyUserId,
          tombstoneRkey: String(boost._id),
          subjectUri: repostRecordUri(boost.oxyUserId, String(boost._id)),
        });
      }

      // Outbound federation: retract the boost with an Undo(Announce). The boost
      // row is already deleted, but the returned doc still carries what we need
      // and the boosted ORIGINAL is untouched, so target resolution still works.
      // Local booster only.
      if (boost.federation == null && boost.boostOf) {
        this.federateBoostChange(
          'post.unboost',
          { _id: boost._id, boostOf: String(boost.boostOf), createdAt: boost.createdAt },
          currentUserId,
        );
      }

      // Update original post boost count and get the updated count
      const updatedPost = await Post.findByIdAndUpdate(
        boost.boostOf,
        { $inc: { 'stats.boostsCount': -1 } },
        { new: true, maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS }
      );

      // Emit real-time update to post room only (not all clients)
      const boostOriginalId = boost.boostOf ? String(boost.boostOf) : '';
      io.to(`post:${boostOriginalId}`).emit('post:unboosted', {
        originalPostId: boost.boostOf,
        postId: boost.boostOf,
        boostId: boost._id,
        boostsCount: updatedPost?.stats?.boostsCount,
        userId: currentUserId,
        actorId: currentUserId,
        timestamp: new Date().toISOString()
      });

      res.json({
        success: true,
        message: 'Boost removed successfully'
      });
    } catch (error) {
      logger.error('Error unboosting', error);
      res.status(500).json({
        error: 'Failed to unboost',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Resolve the ordered self-thread continuation documents for a self-thread root.
   *
   * Single source of truth for the spine query shared by BOTH
   * {@link getThreadContinuations} (renders the connected spine on the post-detail
   * screen) and {@link getRepliesFeed} (expands a root into its whole spine so
   * external replies to ANY spine node surface — Bluesky behavior). The match shape
   * mirrors ThreadSlicingService.fetchThreadChildren: every post in this thread by
   * the SAME author that hangs off the chain (`parentPostId` present), public +
   * published, in chronological (= thread) order, capped at
   * MAX_THREAD_CONTINUATION_DEPTH.
   *
   * Returns the lean documents (not just ids) so the continuation endpoint hydrates
   * them in a single query, while the replies feed maps them to ids — avoiding the
   * extra round-trip an id-only helper would force on `getThreadContinuations`. The
   * caller must already have verified `root` is a self-thread root
   * (`root.threadId === String(root._id)`).
   */
  private getSelfThreadContinuations(root: Pick<IPost, 'oxyUserId' | 'threadId'>) {
    return Post.find({
      threadId: String(root.threadId),
      oxyUserId: root.oxyUserId,
      parentPostId: { $ne: null, $exists: true },
      visibility: PostVisibility.PUBLIC,
      status: 'published',
    })
      .select(this.FEED_FIELDS)
      .sort({ createdAt: 1 })
      .limit(MAX_THREAD_CONTINUATION_DEPTH)
      .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
      .lean();
  }

  async getRepliesFeed(req: AuthRequest, res: Response) {
    try {
      // Only reachable through `GET /feed/replies/:parentId`, so the parent id is
      // always present on the path.
      const parentId = req.params.parentId;

      const currentUserId = req.user?.id;
      const limit = validateAndNormalizeLimit(req.query.limit, FEED_CONSTANTS.DEFAULT_LIMIT);
      const sort = queryString(req.query.sort);
      const cursor = queryString(req.query.cursor);

      // Detect whether the parent is a self-thread ROOT. A self-thread root anchors
      // its own id as `threadId` (see createThread); for such a post the replies feed
      // must surface external replies to ANY node of the OP's continuation spine
      // (root … cN) — Bluesky behavior — not just the root's direct children. The
      // findById is guarded on a valid ObjectId so a non-ObjectId parentId (and any
      // non-root post) simply skips spine expansion and keeps the single-parent query.
      const parent = mongoose.isValidObjectId(parentId)
        ? await Post.findById(parentId)
          .select('_id oxyUserId threadId')
          .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
          .lean()
        : null;
      const isSelfThreadRoot = !!parent?.threadId && String(parent.threadId) === String(parent._id);

      // The OP's own continuations are rendered as the connected spine on the client,
      // so they must NOT also appear as replies. Each continuation hangs off another
      // spine node (c1.parentPostId === root, c2.parentPostId === c1, …) and would
      // otherwise match the expanded parent filter, so exclude them by id. The root
      // has no parentPostId and can never appear as a reply.
      const continuationIds = isSelfThreadRoot && parent
        ? (await this.getSelfThreadContinuations(parent)).map((c) => String(c._id))
        : [];

      const query: FilterQuery<IPost> = {
        parentPostId: continuationIds.length > 0
          ? { $in: [String(parentId), ...continuationIds] }
          : String(parentId),
        visibility: PostVisibility.PUBLIC,
        status: 'published',
      };

      const idConditions: { $nin?: mongoose.Types.ObjectId[]; $lt?: mongoose.Types.ObjectId } = {};
      if (continuationIds.length > 0) {
        idConditions.$nin = continuationIds.map((cid) => new mongoose.Types.ObjectId(cid));
      }
      if (cursor) {
        const cursorId = parseFeedCursor(cursor);
        if (cursorId) idConditions.$lt = cursorId;
      }
      if (idConditions.$nin || idConditions.$lt) {
        query._id = idConditions;
      }

      const feedFieldsProject = Object.fromEntries(
        this.FEED_FIELDS.split(' ').map(f => [f, 1])
      );

      let posts;
      if (sort === 'best') {
        posts = await Post.aggregate([
          { $match: query },
          {
            $addFields: {
              engagementScore: {
                $add: [
                  { $ifNull: ['$stats.likesCount', 0] },
                  { $multiply: [{ $ifNull: ['$stats.boostsCount', 0] }, 2] },
                  { $multiply: [{ $ifNull: ['$stats.commentsCount', 0] }, 1.5] },
                ],
              },
            },
          },
          { $sort: { engagementScore: -1, createdAt: -1 } },
          { $limit: limit + 1 },
          { $project: feedFieldsProject },
        ]).option({ maxTimeMS: FEED_CONSTANTS.QUERY_TIMEOUT_MS });
      } else {
        const sortOrder = sort === 'oldest' ? 1 : -1;
        posts = await Post.find(query)
          .select(this.FEED_FIELDS)
          .sort({ createdAt: sortOrder })
          .limit(limit + 1)
          .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
          .lean();
      }

      const hasMore = posts.length > limit;
      const slicedPosts = hasMore ? posts.slice(0, limit) : posts;

      let filteredPosts = slicedPosts;
      if (currentUserId) {
        const blockedAndMutedIds = await this.getBlockedAndMutedUserIds(currentUserId);
        filteredPosts = this.filterBlockedAndMutedPosts(slicedPosts, blockedAndMutedIds);
      }

      // Hydrate replies at maxDepth 1 so quoted/embedded context (e.g. a reply
      // that is also a quote, or a boosted reply) renders, matching peer
      // endpoints. transformPostsWithProfiles is pinned to maxDepth 0 for feed
      // performance, so hydrate directly here.
      const hydratedReplies = await postHydrationService.hydratePosts(filteredPosts, {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });
      const items = hydratedReplies.filter((post) => post?.id && post.user?.id);
      const nextCursor = hasMore && slicedPosts.length > 0 ? String(slicedPosts[slicedPosts.length - 1]._id) : undefined;

      return res.json({ items, hasMore, nextCursor });
    } catch (error) {
      logger.error('[getRepliesFeed] Error:', error);
      return res.status(500).json({ message: 'Error fetching replies' });
    }
  }

  /**
   * Get the author's self-thread continuation spine for a root post.
   *
   * A self-thread root authored from the composer stamps `threadId === <its own
   * id>` on the root and chains each continuation by the same author via
   * `parentPostId` (root → c1 → c2 …), all sharing that `threadId`. The feed
   * groups this into a single slice (see {@link ThreadSlicingService}), but the
   * generic replies endpoint only returns DIRECT children of one parent, so the
   * post-detail screen could not reconstruct the descending OP chain. This
   * endpoint returns that chain — the same single-author, linear spine the feed
   * slicer uses — ordered chronologically (root-first continuation order).
   *
   * Returns `{ items: [] }` for anything that is not a self-thread root (a plain
   * post, a reply, a mid-thread continuation, a boost, or a non-public root), so
   * the client can call it unconditionally and leave non-thread posts unchanged.
   */
  async getThreadContinuations(req: AuthRequest, res: Response) {
    try {
      const rootId = req.params.rootId;
      if (!rootId || !mongoose.isValidObjectId(rootId)) {
        return res.json({ items: [] });
      }

      const currentUserId = req.user?.id;

      // The spine only applies to a public, published root post whose `threadId`
      // points at itself — the canonical self-thread root signature. A mid-thread
      // continuation has `threadId === <root id> !== <its own id>`, so this guard
      // correctly yields an empty spine when the focused post is not the root.
      const root = await Post.findById(rootId)
        .select('_id oxyUserId threadId visibility status')
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();

      if (
        !root ||
        root.visibility !== PostVisibility.PUBLIC ||
        root.status !== 'published' ||
        !root.oxyUserId ||
        !root.threadId ||
        String(root.threadId) !== String(root._id)
      ) {
        return res.json({ items: [] });
      }

      // Single source of truth for the spine query (shared with getRepliesFeed,
      // which expands a root into this same spine to surface external replies to
      // any node). Identical match shape to ThreadSlicingService.fetchThreadChildren.
      const continuations = await this.getSelfThreadContinuations(root);

      if (continuations.length === 0) {
        return res.json({ items: [] });
      }

      // Hydrate at maxDepth 1 (mirrors getRepliesFeed) so quoted/embedded context
      // on a continuation renders.
      const hydrated = await postHydrationService.hydratePosts(continuations, {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });
      const items = hydrated.filter((post) => post?.id && post.user?.id);

      return res.json({ items });
    } catch (error) {
      logger.error('[getThreadContinuations] Error:', error);
      return res.status(500).json({ message: 'Error fetching thread continuations' });
    }
  }

  /**
   * Get a single feed item by ID with full transformation and user interactions
   */
  async getFeedItemById(req: AuthRequest, res: Response) {
    try {
      const { id } = req.params;
      const currentUserId = req.user?.id;

      if (!id) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      const post = await Post.findById(id)
        .maxTimeMS(FEED_CONSTANTS.QUERY_TIMEOUT_MS)
        .lean();
      if (!post) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const [transformed] = await this.transformPostsWithProfiles([post], currentUserId, createScopedOxyClient(req));

      return res.json(transformed);
    } catch (error) {
      logger.error('Error fetching feed item', error);
      res.status(500).json({ error: 'Failed to fetch feed item' });
    }
  }

  /**
   * Get pinned post for a user
   */
  async getPinnedPost(req: AuthRequest, res: Response) {
    try {
      const userId = req.params.userId as string;
      const currentUserId = req.user?.id;

      if (!userId) {
        return res.status(400).json({ error: 'User ID is required' });
      }

      // Check privacy
      const userSettings = await UserSettings.findOne({ oxyUserId: userId }).lean();
      const profileVisibility = userSettings?.privacy?.profileVisibility || ProfileVisibility.PUBLIC;
      const isOwnProfile = currentUserId === userId;

      if (!isOwnProfile && requiresAccessCheck(profileVisibility)) {
        if (!currentUserId) {
          return res.json({ item: null });
        }
        const hasAccess = await checkFollowAccess(currentUserId, userId);
        if (!hasAccess) {
          return res.json({ item: null });
        }
      }

      const pinnedPost = await Post.findOne({
        oxyUserId: userId,
        'metadata.isPinned': true,
        visibility: PostVisibility.PUBLIC,
      }).sort({ updatedAt: -1 }).lean();

      if (!pinnedPost) {
        return res.json({ item: null });
      }

      const [hydrated] = await postHydrationService.hydratePosts([pinnedPost], {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });
      return res.json({ item: hydrated || null });
    } catch (error) {
      logger.error('Error fetching pinned post', error);
      res.status(500).json({ error: 'Failed to fetch pinned post' });
    }
  }
}

export const feedController = new FeedController();
export default feedController;
