import { Response } from 'express';
import { and, desc, eq, inArray, isNotNull, notInArray, sql, type SQL } from 'drizzle-orm';
import {
  CreateReplyRequest,
  CreateBoostRequest,
  PostType,
  PostVisibility,
  PostContent,
  HydratedPost,
} from '@mention/shared-types';
import {
  mentionTextsFromContent,
  reconcileMentionIds,
} from '@mention/shared-types/mentions';
import { posts as postsTable } from '../db/schema/posts';
import {
  bumpPostCounters,
  CHRONO_DESC,
  deletePostRecord,
  findPostRecords,
  insertPostRecord,
  loadPostRecord,
} from '../db/posts/postRepository';
import { POST_CLASSIFICATION_PENDING, type PostRecord } from '../db/posts/postRecord';
import { isUniqueViolation } from '../db/pgErrors';
import { getRuntimeOxyClient } from '../runtime/oxyClient';
import { getRuntimeSocketServer } from '../runtime/socketServer';
import { userPreferenceService, readInteractionSurface } from '../services/UserPreferenceService';
import { affinityEventService } from '../services/AffinityEventService';
import { postHydrationService } from '../services/PostHydrationService';
import { loadUserSettings } from '../db/userProfile/userSettingsRepository';
import { checkFollowAccess, extractFollowingIds, requiresAccessCheck, ProfileVisibility, OxyClient } from '../utils/privacyHelpers';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { logger } from '../utils/logger';
import { validateAndNormalizeLimit, FEED_CONSTANTS } from '../utils/feedUtils';
import { ChronoCursor, chronoCursorSql, chronoOrderBy, ScoreCursor } from '../mtn/feed/CursorBuilder';
import { rankingWeight } from '../utils/feedQueryBuilder';
import { mergeHashtags } from '../utils/textProcessing';
import { normalizeMediaItems } from '../utils/mediaInput';
import { queryString } from '../utils/queryParams';
import { buildAuthorship } from '../utils/postAuthorship';
import { validatePublicShareTarget } from '../utils/postAccessControl';
import { baselineContentClassifier } from '../services/BaselineContentClassifier';
import { toStoredContent } from '../services/postVariants';
import { createScopedOxyClient } from '../utils/oxyHelpers';
import { federateAsResolvedActor } from '../connectors/outboundFederation';
import {
  emitPostCreated,
  emitRepostCreated,
  emitTombstone,
  repostRecordUri,
} from '../services/mtn/MentionRecordEmitter';
import { sanitizePodcast, resolvePodcastContent } from '../utils/syraPodcast';
import { recordRecentReplierForPost } from '../services/PostRecentReplierService';
import { UserPrivacyManager } from '../mtn/UserPrivacyManager';

/**
 * The one message both "already boosted" answers use.
 *
 * The optimistic read and the unique-index violation are the same fact observed
 * a moment apart, so a client cannot be asked to tell them apart — and two
 * literals would drift the moment one is reworded.
 */
const ALREADY_BOOSTED_ERROR = 'You have already boosted this content';

/**
 * Hard cap on how many posts of an author's self-thread continuation spine the
 * post-detail thread view returns. Threads are short in practice (a handful of
 * continuations); this is a safety ceiling mirroring the frontend ancestor walk
 * guard (MAX_ANCESTOR_DEPTH), guarding against a runaway thread.
 */
const MAX_THREAD_CONTINUATION_DEPTH = 50;

/**
 * The `sort=best` ranking of a replies page: likes, plus boosts weighted 2×,
 * plus replies weighted 1.5×.
 *
 * Declared ONCE, as both a SQL expression and the identical arithmetic in
 * TypeScript, because the page's ORDER BY and its outgoing cursor have to agree
 * on the number to the last bit — a cursor minted from a differently-rounded
 * score bounds the next page in the wrong place and drops or repeats rows.
 *
 * Every weight goes through `rankingWeight`: drizzle infers a bound parameter's
 * type from the column beside it, so a bare `${2.5}` next to an integer column
 * is declared `int4` and Postgres rejects it at runtime while type-checking
 * perfectly. The whole-number weight would survive that; spelling one of the two
 * differently is how the next fractional weight added here fails in production.
 */
const REPLY_BOOST_WEIGHT = 2;
const REPLY_COMMENT_WEIGHT = 1.5;

const REPLY_ENGAGEMENT_SCORE = sql<number>`(
  ${postsTable.statsLikesCount}
  + ${postsTable.statsBoostsCount} * ${rankingWeight(REPLY_BOOST_WEIGHT)}
  + ${postsTable.statsCommentsCount} * ${rankingWeight(REPLY_COMMENT_WEIGHT)}
)`;

function replyEngagementScore(post: PostRecord): number {
  return post.stats.likesCount
    + post.stats.boostsCount * REPLY_BOOST_WEIGHT
    + post.stats.commentsCount * REPLY_COMMENT_WEIGHT;
}

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
  /**
   * Transform posts to include full profile data and engagement stats
   * 
   * @param posts - Raw post documents from database
   * @param currentUserId - Current user ID for personalization
   * @returns Array of hydrated posts with user data and engagement stats
   */
  // Public because the list-timeline route (`routes/lists.ts`) reuses the same
  // hydration path as the controller's own feed endpoints.
  async transformPostsWithProfiles(
    posts: object[],
    currentUserId?: string,
    oxyClient?: OxyClient,
    // Only the single-item detail route asks for quote counts — see
    // `HydrationOptions.includeQuoteCounts` for why the feed does not.
    options: { includeQuoteCounts?: boolean } = {},
  ): Promise<HydratedPost[]> {
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
        includeQuoteCounts: options.includeQuoteCounts === true,
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
  private async getBlockedAndMutedUserIds(
    userId?: string,
    oxyClient?: OxyClient,
  ): Promise<string[]> {
    if (!userId) return [];

    const privacyState = await UserPrivacyManager.loadPrivacyState(userId, {
      oxyClient,
    });
    return Array.from(privacyState.excludedUserIds);
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

    const excludedIds = new Set(blockedAndMutedIds);
    return posts.filter(post => {
      const authorId = post.oxyUserId == null ? '' : String(post.oxyUserId);
      return !excludedIds.has(authorId);
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
    federateAsResolvedActor(boosterOxyUserId, kind, (username) => ({
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
  private federateReply(reply: PostRecord, replierOxyUserId: string): void {
    const createdAt = reply.createdAt.toISOString();
    federateAsResolvedActor(replierOxyUserId, 'reply', (username) => ({
      kind: 'post.create',
      post: {
        _id: reply.id,
        content: reply.content,
        hashtags: reply.hashtags,
        mentions: reply.mentions,
        visibility: reply.visibility,
        createdAt,
        parentPostId: reply.parentPostId,
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
      const parentPost = await loadPostRecord(postId);
      if (!parentPost) {
        return res.status(404).json({ error: 'Post not found' });
      }

      // Check reply permissions
      const permissions: string[] = parentPost.replyPermission;

      if (!permissions.includes('anyone')) {
        const parentAuthorId = parentPost.oxyUserId ?? undefined;

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
                    const authorFollowers = await getRuntimeOxyClient().getUserFollowers(parentAuthorId);
                    canReply = authorFollowers?.followers?.some((f: FollowerRef) => {
                      const followerId = typeof f === 'string' ? f : (f.id || f._id);
                      return followerId === currentUserId || String(followerId) === String(currentUserId);
                    }) || false;
                    break;
                  }
                  case 'following': {
                    if (!parentAuthorId) break;
                    try {
                      const authorFollowing = await getRuntimeOxyClient().getUserFollowing(parentAuthorId);
                      const followingIds = extractFollowingIds(authorFollowing);
                      canReply = followingIds.includes(currentUserId);
                    } catch (error) {
                      logger.warn('Failed to check author following', error);
                    }
                    break;
                  }
                  case 'mentioned': {
                    canReply = parentPost.mentions.some((m: FollowerRef) => {
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
      const reconciledMentions = reconcileMentionIds(
        mentionTextsFromContent(replyContent),
        mentions,
      );

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

      // Stage-A deterministic classification. This native reply path writes the
      // row directly (not via PostCreationService), so the baseline fields are
      // computed here while `status` stays `pending` so the AI batch still
      // enriches it. Best-effort: never block the reply on classification.
      let classification: PostRecord['postClassification'] | undefined;
      let primaryLanguage: string | undefined;
      try {
        const signals = baselineContentClassifier.classify({
          text: replyContent?.text,
          hashtags: mergedTags,
        });
        // The classification carries ONLY the multi-language `languages` array;
        // the primary (`languages[0]`) is written to the top-level AP
        // `post.language`. `attempts` is internal bookkeeping and starts at the
        // column default.
        classification = {
          status: POST_CLASSIFICATION_PENDING,
          attempts: 0,
          topics: signals.topics,
          languages: signals.languages,
          region: signals.region,
          hashtagsNorm: signals.hashtagsNorm,
          sensitive: signals.sensitive,
          scores: signals.scores,
          version: signals.version,
          sentiment: 'neutral',
          intent: 'other',
          confidence: 0,
          classifiedAt: new Date(signals.classifiedAt),
        };
        primaryLanguage = signals.languages[0];
      } catch (classifyError) {
        logger.warn('createReply: baseline classification failed; saving with default pending', classifyError);
      }

      // If reviewReplies is enabled, set visibility to pending or use a flag
      // For now, we'll still create it but mark it for review
      const reply = await insertPostRecord({
        oxyUserId: currentUserId,
        authorship: buildAuthorship(currentUserId, []),
        type: PostType.TEXT,
        // The body's ONLY home is the primary rendition. This path used to write
        // `content.text` straight through, which Mongo tolerated as an undeclared
        // field; `posts` has no text column, so the conversion is what keeps the
        // reply from being stored blank.
        content: toStoredContent(replyContent, primaryLanguage),
        status: 'published',
        visibility: parentPost.reviewReplies ? PostVisibility.PRIVATE : PostVisibility.PUBLIC,
        parentPostId: postId,
        threadId: parentPost.threadId ?? parentPost.id,
        hashtags: mergedTags,
        mentions: reconciledMentions,
        ...(primaryLanguage != null ? { language: primaryLanguage } : {}),
        ...(classification ? { postClassification: classification } : {}),
      });
      await recordRecentReplierForPost(reply);

      // MTN dual-write: a reply emits an `app.mention.feed.post` record with the
      // thread position (reply.root / reply.parent). The direct parent is
      // `parentPost`; the thread root is `parentPost.threadId` (or the parent
      // itself when it IS the root). Resolve the root owner with a lean lookup
      // only when the root differs from the parent. Best-effort, never blocks.
      try {
        const rootId = parentPost.threadId ?? parentPost.id;
        const parentOwner = parentPost.oxyUserId ?? undefined;
        let rootOwner = rootId === parentPost.id ? parentOwner : undefined;
        if (!rootOwner) {
          const rootPost = await loadPostRecord(rootId);
          rootOwner = rootPost?.oxyUserId ?? undefined;
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
      const parentAuthorId = parentPost.oxyUserId ?? undefined;
      if (parentAuthorId) {
        void affinityEventService
          .record({ fromUserId: currentUserId, toUserId: parentAuthorId, type: 'reply', eventId: `reply:${reply.id}` })
          .catch(() => undefined);
      }

      // Update parent post comment count
      await bumpPostCounters(postId, { comments: 1 });

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
      const [hydratedReply] = await postHydrationService.hydratePosts([reply], {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });

      // Emit real-time update to post room only (not all clients)
      getRuntimeSocketServer()?.to(`post:${postId}`).emit('post:replied', {
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

      const originalPost = await loadPostRecord(originalPostId);
      const shareValidation = validatePublicShareTarget(originalPost, { action: 'boost' });
      if (!shareValidation.ok) {
        return res.status(shareValidation.status).json({ error: shareValidation.message });
      }

      /**
       * The cheap answer for the overwhelmingly common case. It is NOT the
       * authority and must not be read as one: there is nothing between this
       * read and the insert below, so two concurrent boosts both see "no". The
       * authority is `posts_one_boost_per_account_key`, whose violation is
       * caught at the insert and answered identically.
       */
      const [existingBoost] = await findPostRecords(
        and(eq(postsTable.oxyUserId, currentUserId), eq(postsTable.boostOf, originalPostId)),
        { orderBy: CHRONO_DESC, limit: 1 },
      );

      if (existingBoost) {
        return res.status(400).json({ error: ALREADY_BOOSTED_ERROR });
      }

      // Create boost
      const mergedTags = mergeHashtags(content?.text || '', hashtags);
      // `CreateBoostRequest.content` is the client's INPUT shape, whose `podcast`
      // carries only an id. A boost never denormalizes a show (the boosted
      // original owns its own attachments), so the field is dropped rather than
      // half-resolved.
      const boostContent: PostContent = { ...(content ?? { text: '' }), podcast: undefined };
      const reconciledMentions = reconcileMentionIds(
        mentionTextsFromContent(boostContent),
        mentions,
      );

      let boost: PostRecord;
      try {
        boost = await insertPostRecord({
          oxyUserId: currentUserId,
          authorship: buildAuthorship(currentUserId, []),
          type: PostType.BOOST,
          // A bare boost has an empty body, so this yields no rendition at all —
          // which is the point: `boostOf` is what hydration renders. A boost with
          // commentary keeps its words as the primary rendition, as before.
          content: toStoredContent(boostContent, undefined),
          status: 'published',
          visibility: PostVisibility.PUBLIC,
          boostOf: originalPostId,
          hashtags: mergedTags,
          mentions: reconciledMentions,
        });
      } catch (error: unknown) {
        /**
         * The loser of two concurrent boosts. NAMED rather than a bare `23505`:
         * this branch answers for one rule, and a future unique index on `posts`
         * must not be silently reported to the client as "already boosted".
         *
         * Nothing is left behind — `insertPostRecord` writes the post and its
         * child rows in ONE transaction, so the violation rolls the whole thing
         * back. The answer is the same 400 the read above would have given, and
         * it is the truthful one: by the time this request finished, that account
         * had boosted that post.
         */
        if (isUniqueViolation(error, 'posts_one_boost_per_account_key')) {
          return res.status(400).json({ error: ALREADY_BOOSTED_ERROR });
        }
        throw error;
      }

      // MTN dual-write: a boost emits an `app.mention.feed.repost` record whose
      // subject is the boosted original's MTN URI. Best-effort, never blocks.
      await emitRepostCreated(boost, originalPostId, originalPost?.oxyUserId ?? undefined);

      // Outbound federation: announce the boost to the booster's remote
      // followers (and, if the original is federated, its author's instance).
      // Local booster only — a native boost has `federation == null`.
      if (boost.federation == null) {
        this.federateBoostChange(
          'post.boost',
          { _id: boost.id, boostOf: originalPostId, createdAt: boost.createdAt },
          currentUserId,
        );
      }

      // Affinity graph: the booster expresses affinity toward the boosted post's
      // author. Fire-and-forget — buffering must never block or fail the boost.
      const boostedAuthorId = originalPost?.oxyUserId ?? undefined;
      if (boostedAuthorId) {
        void affinityEventService
          .record({ fromUserId: currentUserId, toUserId: boostedAuthorId, type: 'boost', eventId: `boost:${boost.id}` })
          .catch(() => undefined);
      }

      // Update original post boost count and get the updated count
      const updatedStats = await bumpPostCounters(originalPostId, { boosts: 1 });

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
      const [hydratedBoost] = await postHydrationService.hydratePosts([boost], {
        viewerId: currentUserId,
        oxyClient: createScopedOxyClient(req),
        maxDepth: 1,
        includeLinkMetadata: true,
      });

      // Emit real-time update to post room only (not all clients)
      getRuntimeSocketServer()?.to(`post:${originalPostId}`).emit('post:boosted', {
        originalPostId,
        postId: originalPostId,
        boost: hydratedBoost,
        boostsCount: updatedStats?.boostsCount,
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
      // Find and delete the boost row created by the current user that points to
      // this original. Read-then-delete rather than one statement: the delete has
      // to answer with the row's own id and `createdAt` for the MTN tombstone and
      // the `Undo(Announce)`, and `deletePostRecord` reads it back for exactly
      // that reason. The delete is still conditioned on the owner, so a concurrent
      // unboost loses the race and 404s rather than deleting twice.
      const [existing] = await findPostRecords(
        and(eq(postsTable.oxyUserId, currentUserId), eq(postsTable.boostOf, postId)),
        { orderBy: CHRONO_DESC, limit: 1 },
      );
      const boost = existing
        ? await deletePostRecord(existing.id, eq(postsTable.oxyUserId, currentUserId))
        : null;

      if (!boost) {
        return res.status(404).json({ error: 'Boost not found' });
      }

      // MTN dual-write: tombstone the boost's `app.mention.feed.repost` record.
      // Only LOCAL boosts ever emitted a record.
      if (boost.federation == null && boost.oxyUserId) {
        await emitTombstone({
          authorOxyUserId: boost.oxyUserId,
          tombstoneRkey: boost.id,
          subjectUri: repostRecordUri(boost.oxyUserId, boost.id),
        });
      }

      // Outbound federation: retract the boost with an Undo(Announce). The boost
      // row is already deleted, but the returned doc still carries what we need
      // and the boosted ORIGINAL is untouched, so target resolution still works.
      // Local booster only.
      if (boost.federation == null && boost.boostOf) {
        this.federateBoostChange(
          'post.unboost',
          { _id: boost.id, boostOf: boost.boostOf, createdAt: boost.createdAt },
          currentUserId,
        );
      }

      // Update original post boost count and get the updated count
      const updatedStats = boost.boostOf
        ? await bumpPostCounters(boost.boostOf, { boosts: -1 })
        : null;

      // Emit real-time update to post room only (not all clients)
      const boostOriginalId = boost.boostOf ?? '';
      getRuntimeSocketServer()?.to(`post:${boostOriginalId}`).emit('post:unboosted', {
        originalPostId: boost.boostOf,
        postId: boost.boostOf,
        boostId: boost.id,
        boostsCount: updatedStats?.boostsCount,
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
  private getSelfThreadContinuations(
    root: Pick<PostRecord, 'id' | 'oxyUserId' | 'threadId'>,
  ): Promise<PostRecord[]> {
    if (!root.threadId || !root.oxyUserId) return Promise.resolve([]);
    return findPostRecords(
      and(
        eq(postsTable.threadId, root.threadId),
        eq(postsTable.oxyUserId, root.oxyUserId),
        // `is not null`, never `<> null`: Mongo's `$ne: null` also matched a
        // MISSING field, while SQL's `<>` against NULL evaluates to NULL and
        // matches nothing — so the literal translation would return an empty
        // spine and silently collapse every self-thread into a bare root.
        isNotNull(postsTable.parentPostId),
        eq(postsTable.visibility, 'public'),
        eq(postsTable.status, 'published'),
      ),
      { orderBy: chronoOrderBy('asc'), limit: MAX_THREAD_CONTINUATION_DEPTH },
    );
  }

  async getRepliesFeed(req: AuthRequest, res: Response) {
    try {
      // Only reachable through `GET /feed/replies/:parentId`, so the parent id is
      // always present on the path.
      const parentId = String(req.params.parentId);

      const currentUserId = req.user?.id;
      const limit = validateAndNormalizeLimit(req.query.limit, FEED_CONSTANTS.DEFAULT_LIMIT);
      const sort = queryString(req.query.sort);
      const cursor = queryString(req.query.cursor);

      // Detect whether the parent is a self-thread ROOT. A self-thread root anchors
      // its own id as `threadId` (see createThread); for such a post the replies feed
      // must surface external replies to ANY node of the OP's continuation spine
      // (root … cN) — Bluesky behavior — not just the root's direct children. An
      // unknown parent id simply reads as no row, so spine expansion is skipped and
      // the single-parent query stands.
      const parent = await loadPostRecord(parentId);
      const isSelfThreadRoot = parent?.threadId === parent?.id;

      // The OP's own continuations are rendered as the connected spine on the client,
      // so they must NOT also appear as replies. Each continuation hangs off another
      // spine node (c1.parentPostId === root, c2.parentPostId === c1, …) and would
      // otherwise match the expanded parent filter, so exclude them by id. The root
      // has no parentPostId and can never appear as a reply.
      const continuationIds = isSelfThreadRoot && parent
        ? (await this.getSelfThreadContinuations(parent)).map((c) => c.id)
        : [];

      const conditions: SQL[] = [
        continuationIds.length > 0
          ? inArray(postsTable.parentPostId, [parentId, ...continuationIds])
          : eq(postsTable.parentPostId, parentId),
        eq(postsTable.visibility, 'public'),
        eq(postsTable.status, 'published'),
      ];
      if (continuationIds.length > 0) {
        conditions.push(notInArray(postsTable.id, continuationIds));
      }

      // `best` ranks by engagement and pages on `(score, id)`, which is a COMPLETE
      // keyset because `id` is unique — ties in score get an arbitrary but stable
      // order and no row is skipped or repeated. `newest`/`oldest` page on the
      // chronological keyset in their OWN direction. What none of them does any
      // more is bound on `_id` alone behind a `createdAt` sort, which is what the
      // Mongo version did in all three modes: harmless while an ObjectId encoded
      // its own creation time, silently skipping and repeating rows the moment
      // ids became uuid v7.
      let orderBy: SQL[];
      if (sort === 'best') {
        const cursorScore = ScoreCursor.parse(cursor);
        orderBy = [desc(REPLY_ENGAGEMENT_SCORE), desc(postsTable.id)];
        if (cursorScore && Number.isFinite(cursorScore.score)) {
          // The bound is CAST rather than compared bare: a parameter beside an
          // expression of unknown type is declared `text` by Postgres, and
          // `double precision < text` has no operator.
          const bound = sql`cast(${cursorScore.score} as double precision)`;
          conditions.push(
            sql`(${REPLY_ENGAGEMENT_SCORE} < ${bound} or (${REPLY_ENGAGEMENT_SCORE} = ${bound} and ${postsTable.id} < ${cursorScore.id}))`,
          );
        }
      } else {
        const direction = sort === 'oldest' ? 'asc' : 'desc';
        orderBy = chronoOrderBy(direction);
        const keyset = await chronoCursorSql(cursor, direction);
        if (keyset) conditions.push(keyset);
      }

      const page = await findPostRecords(and(...conditions), {
        orderBy,
        limit: limit + 1,
      });

      const hasMore = page.length > limit;
      const slicedPosts = hasMore ? page.slice(0, limit) : page;
      const requestOxyClient = createScopedOxyClient(req);

      let filteredPosts = slicedPosts;
      if (currentUserId) {
        const blockedAndMutedIds = await this.getBlockedAndMutedUserIds(
          currentUserId,
          requestOxyClient,
        );
        filteredPosts = this.filterBlockedAndMutedPosts(slicedPosts, blockedAndMutedIds);
      }

      // Hydrate replies at maxDepth 1 so quoted/embedded context (e.g. a reply
      // that is also a quote, or a boosted reply) renders, matching peer
      // endpoints. transformPostsWithProfiles is pinned to maxDepth 0 for feed
      // performance, so hydrate directly here.
      const hydratedReplies = await postHydrationService.hydratePosts(filteredPosts, {
        viewerId: currentUserId,
        oxyClient: requestOxyClient,
        maxDepth: 1,
        includeLinkMetadata: true,
      });
      const items = hydratedReplies.filter((post) => post?.id && post.user?.id);
      const anchor = hasMore ? slicedPosts[slicedPosts.length - 1] : undefined;
      const nextCursor = anchor
        ? (sort === 'best'
          ? ScoreCursor.build(replyEngagementScore(anchor), anchor.id)
          : ChronoCursor.build(anchor.id, anchor.createdAt))
        : undefined;

      return res.json({ items, hasMore, nextCursor });
    } catch (error) {
      logger.error('[getRepliesFeed] Error:', error);
      return res.status(500).json({ message: 'Error fetching replies' });
    }
  }

  /**
   * The posts that quote a given post — the destination behind the "N quotes"
   * count on the post-detail screen. Quotes are POSTS, not actors, so this
   * returns a feed page (same `{items, hasMore, nextCursor}` contract as the
   * replies feed) rather than the user list that backs likes/boosts.
   *
   * Ordered and paged on the SAME two keys — `(created_at DESC, id DESC)` — which
   * is what the old `_id`-only keyset was really reaching for. It ordered by
   * insertion because a `createdAt` sort behind an `_id` cursor skips backfilled
   * rows at every page boundary, and that mismatch is the defect, not the
   * `createdAt` axis. With the id no longer encoding its own creation time
   * (ObjectId hex for pre-cutover rows, uuid v7 after), insertion order is not
   * even recoverable from the key any more, so the two-key keyset is the only
   * form that is both chronological and complete.
   */
  async getQuotesFeed(req: AuthRequest, res: Response) {
    try {
      const postId = String(req.params.postId);
      const currentUserId = req.user?.id;
      const limit = validateAndNormalizeLimit(req.query.limit, FEED_CONSTANTS.DEFAULT_LIMIT);
      const cursor = queryString(req.query.cursor);

      const conditions: SQL[] = [
        eq(postsTable.quoteOf, postId),
        eq(postsTable.visibility, 'public'),
        eq(postsTable.status, 'published'),
      ];
      const keyset = await chronoCursorSql(cursor);
      if (keyset) conditions.push(keyset);

      const page = await findPostRecords(and(...conditions), {
        orderBy: chronoOrderBy(),
        limit: limit + 1,
      });

      const hasMore = page.length > limit;
      const slicedPosts = hasMore ? page.slice(0, limit) : page;
      const requestOxyClient = createScopedOxyClient(req);

      let filteredPosts = slicedPosts;
      if (currentUserId) {
        const blockedAndMutedIds = await this.getBlockedAndMutedUserIds(
          currentUserId,
          requestOxyClient,
        );
        filteredPosts = this.filterBlockedAndMutedPosts(slicedPosts, blockedAndMutedIds);
      }

      // maxDepth 1: every row here quotes the post being viewed, so without the
      // nested original each one renders as a bare comment with no context.
      const hydrated = await postHydrationService.hydratePosts(filteredPosts, {
        viewerId: currentUserId,
        oxyClient: requestOxyClient,
        maxDepth: 1,
        includeLinkMetadata: true,
      });
      const items = hydrated.filter((post) => post?.id && post.user?.id);
      const anchor = hasMore ? slicedPosts[slicedPosts.length - 1] : undefined;
      const nextCursor = anchor ? ChronoCursor.build(anchor.id, anchor.createdAt) : undefined;

      return res.json({ items, hasMore, nextCursor });
    } catch (error) {
      logger.error('[getQuotesFeed] Error:', error);
      return res.status(500).json({ message: 'Error fetching quotes' });
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
      const rootId = String(req.params.rootId ?? '');
      if (!rootId) {
        return res.json({ items: [] });
      }

      const currentUserId = req.user?.id;

      // The spine only applies to a public, published root post whose `threadId`
      // points at itself — the canonical self-thread root signature. A mid-thread
      // continuation has `threadId === <root id> !== <its own id>`, so this guard
      // correctly yields an empty spine when the focused post is not the root.
      const root = await loadPostRecord(rootId);

      if (
        !root ||
        root.visibility !== PostVisibility.PUBLIC ||
        root.status !== 'published' ||
        !root.oxyUserId ||
        !root.threadId ||
        root.threadId !== root.id
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
      const id = String(req.params.id ?? '');
      const currentUserId = req.user?.id;

      if (!id) {
        return res.status(400).json({ error: 'Post ID is required' });
      }

      const post = await loadPostRecord(id);
      if (!post) {
        return res.status(404).json({ error: 'Post not found' });
      }

      // This is the post-detail read (`/p/:id`), the one surface that renders the
      // quote count, so it is the one that pays for counting it.
      const [transformed] = await this.transformPostsWithProfiles(
        [post],
        currentUserId,
        createScopedOxyClient(req),
        { includeQuoteCounts: true },
      );

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
      const userSettings = await loadUserSettings(userId);
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

      const [pinnedPost] = await findPostRecords(
        and(
          eq(postsTable.oxyUserId, userId),
          eq(postsTable.metadataIsPinned, true),
          eq(postsTable.visibility, 'public'),
        ),
        // `updated_at` is NOT NULL, so the descending sort has no NULL ordering
        // to disagree with Mongo about; `id` breaks a tie deterministically so
        // two posts pinned in the same millisecond do not alternate per request.
        { orderBy: [desc(postsTable.updatedAt), desc(postsTable.id)], limit: 1 },
      );

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
