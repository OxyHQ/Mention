import { eq } from 'drizzle-orm';
import { posts } from '../db/schema/posts';
import { CHRONO_DESC, findPostRecords, loadPostRecord } from '../db/posts/postRepository';
import { getDb } from '../db/postgres';
import { bookmarks as bookmarksTable, likes as likesTable } from '../db/schema/engagement';
import type { UserBehaviorRecord } from '../db/userProfile/userBehaviorRecord';
import {
  loadUserBehavior,
  updateUserBehavior,
} from '../db/userProfile/userBehaviorRepository';
import { MtnConfig, isVideoSurface } from '@mention/shared-types';
import { logger } from '../utils/logger';
import { recordSeenTopics } from './viewerRecentTopics';

/**
 * Optional originating-surface context for an interaction. `surface` is the
 * feed-descriptor string the engagement happened on (e.g. `videos`, `for_you`,
 * `author|<id>`, `hashtag|<tag>`). Used for SURFACE-AWARE attribution; absent →
 * normal full attribution (backward compatible).
 */
export interface InteractionContext {
  surface?: string;
}

/**
 * The (lean) post fields {@link UserPreferenceService.recordInteraction} reads
 * when attributing an interaction. A structural subset of the `Post` document so
 * a lean query result is assignable without coupling to the full Mongoose
 * `Document` type. `postClassification` is kept loosely typed to match
 * {@link UserPreferenceService['getCanonicalTopics']}'s tolerant reader.
 */
interface InteractionPost {
  oxyUserId?: string | null;
  type?: string;
  language?: string;
  hashtags?: string[];
  postClassification?: { topicRefs?: unknown; topics?: unknown; region?: unknown };
}

/**
 * Extract the originating feed surface from a write-request body for
 * SURFACE-AWARE attribution. The frontend sends it as `source` (preferred) or
 * `feedContext`; either is the feed-descriptor string (e.g. `videos`, `for_you`,
 * `author|<id>`). Returns `undefined` when absent/blank so attribution falls
 * back to the normal full-weight path. Accepts an arbitrary body object so any
 * controller can call it without importing a request type.
 */
export function readInteractionSurface(
  body: { source?: unknown; feedContext?: unknown } | undefined | null,
): string | undefined {
  const raw = typeof body?.source === 'string'
    ? body.source
    : typeof body?.feedContext === 'string'
      ? body.feedContext
      : undefined;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * UserPreferenceService - Learns user preferences from behavior
 * Similar to how Twitter/Facebook infers user interests
 *
 * Updates user behavior model based on:
 * - Likes, boosts, comments, saves
 * - Time spent viewing posts
 * - Post types interacted with
 * - Topics/hashtags engaged with
 * - Authors interacted with
 */
export class UserPreferenceService {
  // The accumulators (preferredAuthors weight/decay, top-N sort+slice, recency
  // factors, multiplicative skip-decay) are stateful and order-dependent, so the
  // write is a read-modify-write. Feed-impression telemetry fires many concurrent
  // interactions per user, so two writers for one viewer collide routinely.
  // `updateUserBehavior` serializes them on a row lock held for the whole
  // transaction — the loser blocks, then applies its mutation on top of the
  // winner's committed state. The bounded `VersionError`/duplicate-key retry loop
  // this class used to carry existed to emulate exactly that under Mongoose
  // optimistic concurrency, and has no subject now.

  // Learning weights (how much each interaction affects preferences)
  private readonly LEARNING_WEIGHTS = {
    like: 1.0,
    boost: 2.0,
    comment: 2.5,
    save: 1.5,
    share: 1.8,
    view: 0.2,
    skip: -0.5,
    hide: -2.0,
    mute: -3.0,
    block: -5.0
  };

  /**
   * Update user behavior based on interaction.
   *
   * SURFACE-AWARE: when `context.surface` indicates a video-first feed (reels),
   * AUTHOR affinity is dampened and CONTENT (post-type + topic) affinity is
   * slightly amplified — a reels like means "I like this video content", not
   * "follow this author". Omitting `context` preserves full attribution.
   *
   * @param userId - Oxy user ID (from req.user?.id)
   * @param postId - Post ID
   * @param interactionType - Type of interaction
   * @param context - Optional originating-surface context (feed descriptor)
   */
  async recordInteraction(
    userId: string, // Oxy user ID
    postId: string,
    interactionType: 'like' | 'boost' | 'comment' | 'save' | 'share' | 'view' | 'skip' | 'hide' | 'mute' | 'block',
    context?: InteractionContext
  ): Promise<void> {
    try {
      logger.debug('[UserPreference] recording interaction', {
        type: interactionType,
      });

      const post = await loadPostRecord(postId);
      if (!post) {
        logger.warn('[UserPreference] post not found; skipping interaction');
        return;
      }

      // Feed the viewer's RECENT-TOPIC set (powers the opt-in `noveltyBoost`
      // ranking signal). Positive signals only — a genuine view / like / etc.
      // means the viewer was exposed to these topics. Best-effort and
      // fire-and-forget (the helper never rejects), so it never blocks or fails
      // interaction recording.
      if ((this.LEARNING_WEIGHTS[interactionType] || 0) > 0) {
        const seenTopics = [
          ...this.getCanonicalTopics(post)
            .map((t) => (typeof t.name === 'string' ? t.name : ''))
            .filter((name) => name.length > 0),
          ...(Array.isArray(post.hashtags) ? post.hashtags : []),
        ];
        if (seenTopics.length > 0) {
          void recordSeenTopics(userId, seenTopics);
        }
      }

      // One read-modify-write, serialized against every other interaction for
      // this viewer by the row lock `applyInteraction` takes — see the class
      // comment for why there is no retry loop around it any more.
      await this.applyInteraction(userId, post, interactionType, context);
      logger.debug('[UserPreference] saved user behavior');
    } catch (error) {
      logger.error('[UserPreference] error recording interaction', error);
      // Re-throw to see full error stack
      throw error;
    }
  }

  /**
   * One read-modify-write pass for {@link recordInteraction}: applies the full
   * accumulator mutation to the viewer's behaviour under a row lock held for the
   * whole transaction, creating the record when this is their first interaction.
   *
   * Everything the mutation needs that does NOT depend on the stored state is
   * computed before the lock is taken; the callback itself is synchronous, so
   * the lock is never held across a round trip.
   */
  private async applyInteraction(
    userId: string,
    post: InteractionPost,
    interactionType: 'like' | 'boost' | 'comment' | 'save' | 'share' | 'view' | 'skip' | 'hide' | 'mute' | 'block',
    context?: InteractionContext,
  ): Promise<void> {
    const weight = this.LEARNING_WEIGHTS[interactionType] || 0;
    // A negative weight is a NEGATIVE signal (e.g. `skip`): it must not be
    // allowed to look like positive engagement. Positive-only accumulators
    // (author interaction count, post-type preference, active hours) are
    // skipped for negative signals; the negative effect is applied explicitly.
    const isPositiveSignal = weight > 0;

    // SURFACE-AWARE attribution split. On a video-first surface (reels), an
    // engagement is about the CONTENT, not the author: dampen author affinity,
    // (slightly) amplify content (post-type/topic) affinity. Off video surfaces
    // both factors are 1.0 → identical to the prior behavior.
    const ctx = MtnConfig.preferences.engagementContext;
    const fromVideoSurface = isVideoSurface(context?.surface);
    // Author affinity is DAMPENED on video surfaces; this factor scales the
    // normalized relationship weight (see updateAuthorPreference) rather than
    // the raw input weight, because the relationship weight is derived from the
    // per-type interaction COUNTS, not from the input weight — scaling the input
    // alone would have no effect on the stored author weight.
    const authorAffinityFactor = fromVideoSurface ? ctx.videoSurfaceAuthorAffinityFactor : 1;
    const contentWeight = weight * (fromVideoSurface ? ctx.videoSurfaceContentBoost : 1);

    await updateUserBehavior(userId, (userBehavior) => {
      // Update author preference (positive signals strengthen the relationship).
      // Dampened on video surfaces so reels likes barely move "follow this author".
      if (post.oxyUserId && isPositiveSignal) {
        this.updateAuthorPreference(
          userBehavior,
          post.oxyUserId,
          interactionType,
          weight,
          authorAffinityFactor
        );
      }

      // Update topic preferences (positive signals only — skipping a topic must
      // not increase interest in it). Uses the content weight (amplified on video).
      if (isPositiveSignal && post.hashtags && post.hashtags.length > 0) {
        for (const hashtag of post.hashtags) {
          this.updateTopicPreference(
            userBehavior,
            hashtag.toLowerCase(),
            contentWeight
          );
        }
      }

      // Update topic preferences from classified topics (richer signal). Prefer
      // the canonical `postClassification.topicRefs` (registry-linked), falling
      // back to `postClassification.topics`. Canonical refs may carry no relevance
      // (AI topics are slug-only), so an absent relevance scales by the full
      // content weight (relevance factor 1) rather than zeroing the signal.
      if (isPositiveSignal) {
        for (const topic of this.getCanonicalTopics(post)) {
          if (typeof topic.name !== 'string' || topic.name.length === 0) continue;
          const relevanceFactor =
            typeof topic.relevance === 'number' ? topic.relevance / 10 : 1;
          this.updateTopicPreference(
            userBehavior,
            topic.name.toLowerCase(),
            contentWeight * relevanceFactor,
            topic.topicId,
          );
        }
      }

      // Update post type preference (positive signals only — a skipped post type
      // should not be promoted just because it was scrolled past). Uses the
      // content weight so a reels like reinforces "I like video content".
      if (isPositiveSignal) {
        const postType = (post.type || 'text').toLowerCase() as keyof typeof userBehavior.preferredPostTypes;
        if (postType in userBehavior.preferredPostTypes) {
          userBehavior.preferredPostTypes[postType] =
            (userBehavior.preferredPostTypes[postType] || 0) + contentWeight;
        }
      }

      // Record active hour for any engagement (including a genuine view) — it
      // reflects WHEN the user is on the app, independent of sentiment. A pure
      // skip still means the user was active, so we record it too.
      const hour = new Date().getHours();
      if (!userBehavior.activeHours.includes(hour)) {
        userBehavior.activeHours.push(hour);
        // Keep only last 168 hours (1 week) of activity
        userBehavior.activeHours = userBehavior.activeHours.slice(-168);
      }

      // Update language preference
      if (post.language && !userBehavior.preferredLanguages.includes(post.language)) {
        userBehavior.preferredLanguages.push(post.language);
      }

      // Update REGION affinity (positive signals only — a skip must not increase
      // interest in a region). Region is a CONTENT-origin signal, so it uses the
      // content weight (amplified on video surfaces) like topics/post-type. It is
      // best-effort and frequently absent — `postClassification.region` is itself
      // derived only from a federated instance domain or author locale, never from
      // post text — so this no-ops for most native posts. When present, the
      // dominant region accrues a stable count (read via `getTopRegion`).
      if (isPositiveSignal) {
        const region = post.postClassification?.region;
        if (typeof region === 'string' && region.length > 0) {
          this.updateRegionPreference(userBehavior, region, contentWeight);
        }
      }

      // Handle hard negative signals (hide/mute/block) — author/topic suppression.
      if (interactionType === 'hide' || interactionType === 'mute' || interactionType === 'block') {
        this.handleNegativeSignal(userBehavior, post, interactionType);
      }

      // Handle the soft negative signal (skip): the viewer scrolled past quickly.
      // This is NOT a suppression — it only nudges down an existing author
      // preference weight so a repeatedly-skipped author gradually loses its
      // boost. It never creates a preference entry or hides the author.
      if (interactionType === 'skip' && post.oxyUserId) {
        this.decayAuthorPreference(userBehavior, post.oxyUserId, Math.abs(weight));
      }

      userBehavior.lastUpdated = new Date();
    }, { createIfMissing: true });
  }

  /**
   * Update author relationship strength
   * Note: This is synchronous as it only modifies objects in memory
   */
  private updateAuthorPreference(
    userBehavior: UserBehaviorRecord,
    authorId: string,
    interactionType: string,
    weight: number,
    // SURFACE-AWARE dampener applied to the FINAL normalized relationship weight.
    // 1 = no dampening (default / non-video surface); <1 = a video-surface
    // engagement contributes proportionally less toward "follow this author".
    authorAffinityFactor: number = 1
  ): void {
    let authorPref = userBehavior.preferredAuthors.find(
      (a) => a.authorId === authorId
    );

    if (!authorPref) {
      authorPref = {
        authorId,
        interactionCount: 0,
        lastInteractionAt: new Date(),
        interactionTypes: {
          likes: 0,
          boosts: 0,
          comments: 0,
          saves: 0,
          shares: 0
        },
        weight: 0
      };
      userBehavior.preferredAuthors.push(authorPref);
    }

    // Update interaction count
    authorPref.interactionCount += Math.abs(weight);
    authorPref.lastInteractionAt = new Date();

    // Update specific interaction type
    if (interactionType === 'like') {
      authorPref.interactionTypes.likes += 1;
    }
    if (interactionType === 'boost') {
      authorPref.interactionTypes.boosts += 1;
    }
    if (interactionType === 'comment') {
      authorPref.interactionTypes.comments += 1;
    }
    if (interactionType === 'save') {
      authorPref.interactionTypes.saves += 1;
    }
    if (interactionType === 'share') {
      authorPref.interactionTypes.shares += 1;
    }

    // Calculate relationship weight (0-1 scale)
    // Based on interaction count and recency
    const totalInteractions =
      authorPref.interactionTypes.likes +
      authorPref.interactionTypes.boosts * 2 +
      authorPref.interactionTypes.comments * 2 +
      authorPref.interactionTypes.saves * 1.5 +
      authorPref.interactionTypes.shares * 2;

    const daysSinceLastInteraction =
      (Date.now() - authorPref.lastInteractionAt.getTime()) / (1000 * 60 * 60 * 24);

    // Weight decays over time, but is normalized to 0-1. The surface-aware
    // dampener (authorAffinityFactor) scales it DOWN for video-surface
    // engagements so a reels like barely moves "follow this author".
    const recencyFactor = Math.max(0, 1 - daysSinceLastInteraction / 30); // Decay over 30 days
    authorPref.weight = Math.min(1, (totalInteractions / 100) * recencyFactor * authorAffinityFactor);

    // Keep only top 100 authors by weight
    userBehavior.preferredAuthors.sort((a, b) => b.weight - a.weight);
    if (userBehavior.preferredAuthors.length > 100) {
      userBehavior.preferredAuthors = userBehavior.preferredAuthors.slice(0, 100);
    }
  }

  /**
   * Soft-negative author signal: nudge down an EXISTING author preference weight
   * (e.g. on a `skip`). Does nothing if the viewer has no preference entry for
   * the author — a skip should never create or hide an author, only erode an
   * accumulated boost so a repeatedly-skipped author drifts back toward neutral.
   * Note: synchronous — only modifies in-memory objects.
   */
  private decayAuthorPreference(
    userBehavior: UserBehaviorRecord,
    authorId: string,
    magnitude: number
  ): void {
    const authorPref = userBehavior.preferredAuthors.find(
      (a) => a.authorId === authorId
    );
    if (!authorPref) {
      return; // No existing relationship — nothing to erode.
    }

    // Reduce the weight proportionally to the skip magnitude, clamped to >= 0.
    // 0.1 keeps a single skip gentle; sustained skipping compounds toward 0.
    const decayFactor = Math.max(0, 1 - magnitude * 0.1);
    authorPref.weight = Math.max(0, authorPref.weight * decayFactor);
    authorPref.lastInteractionAt = new Date();
  }

  /**
   * The canonical classified topics for a post, PREFERRING the registry-linked
   * `postClassification.topicRefs` and FALLING BACK to the slug-only
   * `postClassification.topics` (each slug normalized to `{ name }`). Returns `[]`
   * when neither exists so a topic-less post contributes no topic preference. Each
   * entry exposes `name`; only `topicRefs` carries the optional `topicId` and
   * `relevance` (the slug list is name-only, so it learns preferences by name).
   */
  private getCanonicalTopics(
    post: { postClassification?: { topicRefs?: unknown; topics?: unknown } },
  ): Array<{ name?: unknown; topicId?: string; relevance?: number }> {
    const refs = post.postClassification?.topicRefs;
    if (Array.isArray(refs) && refs.length > 0) {
      return refs;
    }
    const topics = post.postClassification?.topics;
    if (Array.isArray(topics) && topics.length > 0) {
      return topics.map((name: unknown) => ({ name }));
    }
    return [];
  }

  /**
   * Update topic preference
   * Note: This is synchronous as it only modifies objects in memory
   */
  private updateTopicPreference(
    userBehavior: UserBehaviorRecord,
    topic: string,
    weight: number,
    topicId?: string,
  ): void {
    let topicPref = userBehavior.preferredTopics.find(
      (t) => t.topic === topic
    );

    if (!topicPref) {
      topicPref = {
        topic,
        interactionCount: 0,
        lastInteractionAt: new Date(),
        weight: 0,
        ...(topicId ? { topicId } : {}),
      };
      userBehavior.preferredTopics.push(topicPref);
    } else if (topicId && !topicPref.topicId) {
      // Backfill topicId on existing preference entries
      topicPref.topicId = topicId;
    }

    topicPref.interactionCount += Math.abs(weight);
    topicPref.lastInteractionAt = new Date();

    // Calculate topic weight
    const daysSinceLastInteraction =
      (Date.now() - topicPref.lastInteractionAt.getTime()) / (1000 * 60 * 60 * 24);
    const recencyFactor = Math.max(0, 1 - daysSinceLastInteraction / 30);
    topicPref.weight = Math.min(1, (topicPref.interactionCount / 50) * recencyFactor);

    // Keep only top 200 topics
    userBehavior.preferredTopics.sort((a, b) => b.weight - a.weight);
    if (userBehavior.preferredTopics.length > 200) {
      userBehavior.preferredTopics = userBehavior.preferredTopics.slice(0, 200);
    }
  }

  /**
   * Accumulate REGION affinity as a counted multiset entry. Unlike author/topic
   * preferences this is a simple recency-stamped count (no normalized 0–1
   * weight): the consumer only needs the DOMINANT region, and a raw count picks
   * a stable winner without thrashing on every engagement. Sorted by count so
   * `getTopRegion` reads index 0; kept bounded so a viewer who roams many
   * instances can't grow the array unboundedly.
   * Note: synchronous — only modifies in-memory objects.
   */
  private updateRegionPreference(
    userBehavior: UserBehaviorRecord,
    region: string,
    weight: number,
  ): void {
    let regionPref = userBehavior.preferredRegions.find(
      (r) => r.region === region,
    );

    if (!regionPref) {
      regionPref = { region, count: 0, lastInteractionAt: new Date() };
      userBehavior.preferredRegions.push(regionPref);
    }

    regionPref.count += Math.abs(weight);
    regionPref.lastInteractionAt = new Date();

    // Most-engaged region first; bound the list (regions are a small, coarse
    // space — this cap is just a safety ceiling, not an expected trim point).
    userBehavior.preferredRegions.sort((a, b) => b.count - a.count);
    if (userBehavior.preferredRegions.length > MtnConfig.preferences.maxPreferredRegions) {
      userBehavior.preferredRegions = userBehavior.preferredRegions.slice(
        0,
        MtnConfig.preferences.maxPreferredRegions,
      );
    }
  }

  /**
   * The viewer's DOMINANT learned region (the highest-count `preferredRegions`
   * entry), or `undefined` when the viewer has learned none. Best-effort and
   * often `undefined` because post region is itself sparse — callers must treat
   * a missing region as a no-op (never error, never empty a feed). Accepts the
   * lean behavior shape used across the feed pipeline.
   */
  getTopRegion(
    userBehavior: { preferredRegions?: Array<{ region?: string; count?: number }> } | null | undefined,
  ): string | undefined {
    const regions = userBehavior?.preferredRegions;
    if (!Array.isArray(regions) || regions.length === 0) return undefined;
    let top: { region?: string; count?: number } | undefined;
    for (const entry of regions) {
      if (typeof entry?.region !== 'string' || entry.region.length === 0) continue;
      if (!top || (entry.count ?? 0) > (top.count ?? 0)) top = entry;
    }
    return top?.region;
  }

  /**
   * Handle negative signals (hide, mute, block)
   * Note: This is synchronous as it only modifies objects in memory
   */
  private handleNegativeSignal(
    userBehavior: UserBehaviorRecord,
    post: InteractionPost,
    interactionType: string
  ): void {
    const authorId = post.oxyUserId ?? '';

    if (interactionType === 'hide') {
      if (!userBehavior.hiddenAuthors.includes(authorId)) {
        userBehavior.hiddenAuthors.push(authorId);
      }
    }

    if (interactionType === 'mute') {
      if (!userBehavior.mutedAuthors.includes(authorId)) {
        userBehavior.mutedAuthors.push(authorId);
      }
    }

    if (interactionType === 'block') {
      if (!userBehavior.blockedAuthors.includes(authorId)) {
        userBehavior.blockedAuthors.push(authorId);
      }
    }

    // Remove from preferred authors if present. The repository turns this into a
    // DELETE of exactly that author's row — the surviving preferences keep their
    // own rows rather than being re-inserted around it.
    userBehavior.preferredAuthors = userBehavior.preferredAuthors.filter(
      (a) => a.authorId !== authorId
    );

    // Handle hidden topics
    if (interactionType === 'hide' && post.hashtags && post.hashtags.length > 0) {
      for (const tag of post.hashtags) {
        if (!userBehavior.hiddenTopics.includes(tag.toLowerCase())) {
          userBehavior.hiddenTopics.push(tag.toLowerCase());
        }
      }
    }
  }

  /**
   * Batch update user preferences from historical data
   * Useful for initial setup or periodic recalculation
   */
  async batchUpdatePreferences(userId: string): Promise<void> {
    try {
      // A viewer with no learned behaviour has nothing to REBUILD — the replays
      // below would create one from scratch, which is `recordInteraction`'s job
      // and not this sweep's.
      if (!(await loadUserBehavior(userId))) {
        return;
      }

      // Postgres. These read the Mongo collections until now, which stopped
      // receiving engagement when the command service moved — so a rebuild would
      // have re-derived a user's affinity from whatever they had liked BEFORE
      // the cutover and nothing since, getting quietly worse the longer the
      // account stayed active.
      //
      // `value` is deliberately NOT filtered, which preserves the previous
      // behaviour exactly: the Mongo read did not filter either. It is worth a
      // second look on its own — `likes` is three-state (`1` up, `-1` down, no
      // row) and a downvote being fed in as a `'like'` interaction is a
      // pre-existing question this port is not the place to answer.
      const likeRows = await getDb()
        .select({ postId: likesTable.postId })
        .from(likesTable)
        .where(eq(likesTable.userId, userId));
      for (const like of likeRows) {
        await this.recordInteraction(userId, like.postId, 'like');
      }

      const bookmarkRows = await getDb()
        .select({ postId: bookmarksTable.postId })
        .from(bookmarksTable)
        .where(eq(bookmarksTable.userId, userId));
      for (const bookmark of bookmarkRows) {
        await this.recordInteraction(userId, bookmark.postId, 'save');
      }

      // Get all user's posts (to infer preferences)
      const userPosts = await findPostRecords(eq(posts.oxyUserId, userId), {
        orderBy: CHRONO_DESC,
      });
      // PERSISTED — the Mongo version mutated a document loaded before the two
      // replays above and then returned without saving it, so every topic
      // preference this loop derived was discarded. The whole point of the sweep
      // is the rebuild, and a load-modify-write that never writes is not a
      // behaviour worth reproducing. Runs last so it reads the state the replays
      // just committed rather than a snapshot taken before them.
      await updateUserBehavior(userId, (userBehavior) => {
        for (const post of userPosts) {
          // User creating posts with certain hashtags = interest
          for (const hashtag of post.hashtags) {
            this.updateTopicPreference(
              userBehavior,
              hashtag.toLowerCase(),
              0.5 // Lower weight for creation vs interaction
            );
          }
        }
      });
    } catch (error) {
      logger.error('[UserPreference] error batch updating preferences', error);
    }
  }

  /**
   * Get user behavior data. `null` when the viewer has none yet.
   */
  async getUserBehavior(userId: string): Promise<UserBehaviorRecord | null> {
    return await loadUserBehavior(userId);
  }

  /**
   * Track time spent viewing post (for engagement metrics)
   */
  async recordViewTime(
    userId: string,
    postId: string,
    viewTimeSeconds: number
  ): Promise<void> {
    try {
      // Update average engagement time (exponential moving average). A viewer
      // with no behaviour row is left alone — including the skip below — which
      // is what the Mongo version's early `return` on a missing document did.
      const alpha = 0.1; // Learning rate
      const updated = await updateUserBehavior(userId, (userBehavior) => {
        userBehavior.averageEngagementTime =
          userBehavior.averageEngagementTime * (1 - alpha) + viewTimeSeconds * alpha;
      });
      if (!updated) {
        return;
      }

      // If view time is very short, it's likely a skip. Recorded AFTER the
      // average lands: it takes the same row lock, and the Mongo ordering wrote
      // the average back from a document the skip had already superseded.
      if (viewTimeSeconds < 2) {
        await this.recordInteraction(userId, postId, 'skip');
      }
    } catch (error) {
      logger.error('[UserPreference] error recording view time', error);
    }
  }
}

export const userPreferenceService = new UserPreferenceService();
