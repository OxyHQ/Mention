/**
 * Shared inputs for the modular ranking-signal registry.
 *
 * The For You / Explore / Videos ranking score is the PRODUCT of a set of
 * per-signal multipliers. Each signal is a PURE function of two things:
 *   1. the candidate {@link RankablePost} being scored, and
 *   2. a {@link SignalContext} — the per-request, viewer-scoped state resolved
 *      ONCE by `FeedRankingService` (following set, learned behavior, author
 *      follower/verified maps, opt-in signal data, feed settings…).
 *
 * `FeedRankingService.calculatePostScore` is the orchestrator: it builds one
 * `SignalContext` via {@link buildSignalContext}, iterates the registry, and
 * combines the contributions. This module owns the shapes every signal reads so
 * the signal files stay free of any orchestration or Mongoose coupling.
 */

import type { PostClassification } from '@mention/shared-types';
import type { IUserBehavior } from '../../models/UserBehavior';

/**
 * The lean user-behavior shape the ranking signals read. A relaxed view of
 * {@link IUserBehavior}: every field optional (the doc may be a partial
 * `.lean()` result, absent entirely for anonymous viewers, or supplied by the
 * caller) and each preference entry only declares the fields ranking reads, so
 * callers can pass minimal behavior objects. Every signal degrades to neutral
 * when a field is absent.
 */
export interface RankingUserBehavior {
  preferredAuthors?: Array<{ authorId: string; weight: number }>;
  preferredTopics?: Array<{ topic: string; topicId?: unknown; weight: number }>;
  preferredPostTypes?: Partial<IUserBehavior['preferredPostTypes']>;
  preferredLanguages?: string[];
  activeHours?: number[];
  hiddenAuthors?: string[];
  mutedAuthors?: string[];
  blockedAuthors?: string[];
  hiddenTopics?: string[];
}

/**
 * Pre-resolved O(1)-lookup sets derived from a {@link RankingUserBehavior} doc,
 * built once per request by {@link buildBehaviorSets} so the negative-penalty
 * and personalization signals never rebuild them per post.
 */
export interface BehaviorSets {
  hiddenAuthors: Set<string>;
  mutedAuthors: Set<string>;
  blockedAuthors: Set<string>;
  hiddenTopics: Set<string>;
  preferredTopicIds: Set<string>;
}

/**
 * Per-viewer feed tuning loaded from the user's `feedSettings` profile field.
 * All optional — every knob falls back to the `MtnConfig.ranking` default when
 * unset (see `routes/profileSettings.ts` for the write side).
 */
export interface FeedRankingSettings {
  recency?: { halfLifeHours?: number; maxAgeHours?: number };
  diversity?: {
    enabled?: boolean;
    sameAuthorPenalty?: number;
    sameTopicPenalty?: number;
    maxConsecutiveSameAuthor?: number;
  };
}

/**
 * Per-request data the OPT-IN (Phase 2b) ranking signals read. Every field is
 * optional and every opt-in scorer degrades to a NEUTRAL `1.0` multiplier when
 * its field is absent, so this context is purely additive: a definition that
 * enables none of the opt-in signals passes an empty (or absent)
 * {@link enabledSignals} and ranking is byte-for-byte unchanged. `rankPosts`
 * resolves the maps/sets below from the pool + viewer context, but ONLY for the
 * signals actually enabled.
 */
export interface OptInSignalContext {
  /**
   * The `weightKey`s of the opt-in signals the feed definition enabled. An
   * opt-in scorer contributes ONLY when its key is in this set; when the set is
   * absent or empty, NO opt-in signal fires (the preset default).
   */
  enabledSignals?: Set<string>;
  /** Post ids the viewer has already seen — `penalizeSeen`. */
  seenPostIdsSet?: Set<string>;
  /** Oxy authorId → verified flag — `verifiedBoost`. */
  authorVerified?: Map<string, boolean>;
  /** postId → count of network (following ∪ mutuals) engagers — `socialProof`. */
  networkEngagerCounts?: Map<string, number>;
  /** The viewer's mutual-follow author id set — `reciprocityBoost`. */
  mutualIdsSet?: Set<string>;
  /** postId → average impression dwell time in ms — `dwellTime`. */
  dwellAverages?: Map<string, number>;
  /** Topic slugs/ids the viewer has recently seen — `noveltyBoost`. */
  viewerRecentTopics?: Set<string>;
  /**
   * Oxy authorId → bounded starter-pack CURATION score — `starterPackBoost`.
   * Resolved from the same cached user-summary batch as the follower counts (see
   * `services/starterPackCuration.ts`), so it adds no query. An author absent from
   * the map is uncurated ⇒ the signal is exactly neutral.
   */
  authorStarterPackScores?: Map<string, number>;
}

/**
 * The post document shape the ranking pipeline operates on: a lean Post plus the
 * runtime ranking-breakdown fields the orchestrator attaches in place
 * (`finalScore`, `_rank*`, `rankingExplanation`). Posts arrive as `.lean()`
 * results from feed queries, so this is a structural view over `IPost` rather
 * than a hydrated document.
 */
export interface RankablePost {
  _id?: unknown;
  oxyUserId?: string;
  // Optional so lean candidate projections without a timestamp still satisfy the
  // type; a missing value yields an Invalid Date which every reader treats as a
  // very old post (recency 0 / no trending boost).
  createdAt?: Date | string;
  type?: string;
  /**
   * DISCOVERY marker (Phase 4) stamped by the engine on candidates that entered
   * via a non-trusted lane. Read by the `languageMismatchPenalty` signal, which
   * only ever penalizes `_discovery` posts (trusted-lane posts are never marked).
   */
  _discovery?: boolean;
  hashtags?: string[];
  threadId?: string;
  parentPostId?: string;
  language?: string;
  // Lean feed projections carry `content` for media-aware signals; only the
  // `media` array is read here (presence check), so it is intentionally opaque.
  content?: { media?: unknown[] | null };
  stats?: Partial<{
    likesCount: number;
    boostsCount: number;
    /** Federated (ActivityPub Announce) subset of `boostsCount`; weighted lower. */
    federatedBoostsCount: number;
    commentsCount: number;
    viewsCount: number;
    sharesCount: number;
  }>;
  metadata?: { savedBy?: unknown[]; isSensitive?: boolean | null };
  federation?: { sensitive?: boolean | null };
  // Partial: lean feed projections may carry only a subset of classification
  // fields (e.g. candidate sources select `sensitive`/`topics` only). Every
  // ranking signal that reads classification already degrades to neutral when a
  // field is absent.
  postClassification?: Partial<PostClassification>;
  // Runtime ranking breakdown fields attached by the orchestrator.
  finalScore?: number;
  rankingExplanation?: unknown;
  _rankEngagement?: number;
  _rankRecency?: number;
  _rankRelationship?: number;
  _rankPersonalization?: number;
  _rankQuality?: number;
  _rankDiversity?: number;
}

/**
 * The context object `FeedRankingService.calculatePostScore` accepts. A superset
 * of {@link OptInSignalContext} with the viewer/session inputs the core signals
 * read. Every field is optional so anonymous / minimal callers work unchanged;
 * {@link buildSignalContext} normalizes it into a {@link SignalContext}.
 */
export interface CalculatePostScoreContext extends OptInSignalContext {
  followingIds?: string[];
  userBehavior?: RankingUserBehavior;
  feedSettings?: FeedRankingSettings;
  /** Optional pre-calculated engagement scores (postId → score). */
  engagementScoreCache?: Map<string, number>;
  followingIdsSet?: Set<string>;
  behaviorSets?: BehaviorSets;
  /** Oxy authorId → follower count, for the author-authority signal. */
  authorFollowerCounts?: Map<string, number>;
  /**
   * Whether the viewer opted in to sensitive/NSFW content. When true, the
   * sensitive/NSFW hard-zero in the negative penalty is skipped so sensitive
   * posts rank normally for this viewer. Defaults to false (SFW).
   */
  showSensitiveContent?: boolean;
  /**
   * The viewer's account languages as BCP-47 locales (`es-ES`), for the
   * `languageMismatchPenalty` signal, which matches them against a post's ISO
   * 639-1 classification languages on the BASE subtag. Empty/absent ⇒ neutral
   * (never penalize).
   */
  viewerLanguages?: string[];
}

/**
 * The fully-resolved, per-request inputs every ranking signal reads. Built ONCE
 * per `calculatePostScore` call from a {@link CalculatePostScoreContext}; sets
 * and maps are already materialized for O(1) per-post lookups.
 */
export interface SignalContext {
  /** The viewer's Oxy user id, or `undefined` for anonymous viewers. */
  userId?: string;
  /** The viewer's following set (Oxy user ids) — resolved once. */
  followingIdsSet: Set<string>;
  userBehavior?: RankingUserBehavior;
  behaviorSets?: BehaviorSets;
  /** Oxy authorId → follower count, for the author-authority + cold-start signals. */
  authorFollowerCounts?: Map<string, number>;
  /** Whether the viewer opted in to sensitive/NSFW content (default false → SFW). */
  showSensitiveContent: boolean;
  /** The viewer's account languages (BCP-47 locales), for `languageMismatchPenalty`. */
  viewerLanguages?: string[];
  feedSettings?: FeedRankingSettings;
  /** Optional pre-calculated engagement scores (postId → score). */
  engagementScoreCache?: Map<string, number>;
  /** Enabled opt-in signal keys; empty/absent ⇒ no opt-in signal fires. */
  enabledSignals?: Set<string>;
  seenPostIdsSet?: Set<string>;
  authorVerified?: Map<string, boolean>;
  networkEngagerCounts?: Map<string, number>;
  mutualIdsSet?: Set<string>;
  dwellAverages?: Map<string, number>;
  viewerRecentTopics?: Set<string>;
  authorStarterPackScores?: Map<string, number>;
}

/**
 * Build the pre-resolved O(1) behavior sets for a viewer from their (possibly
 * absent) learned-behavior doc. Returns `undefined` for anonymous / behavior-less
 * viewers so callers can short-circuit personalization entirely.
 */
export function buildBehaviorSets(
  userBehavior: RankingUserBehavior | undefined,
): BehaviorSets | undefined {
  if (!userBehavior) return undefined;
  return {
    hiddenAuthors: new Set<string>(userBehavior.hiddenAuthors || []),
    mutedAuthors: new Set<string>(userBehavior.mutedAuthors || []),
    blockedAuthors: new Set<string>(userBehavior.blockedAuthors || []),
    hiddenTopics: new Set<string>((userBehavior.hiddenTopics || []).map((t) => t.toLowerCase())),
    preferredTopicIds: new Set<string>(
      (userBehavior.preferredTopics || [])
        .filter((t) => t.topicId && t.weight > 0.3)
        .map((t) => String(t.topicId)),
    ),
  };
}

/**
 * Normalize a caller-supplied {@link CalculatePostScoreContext} into a
 * {@link SignalContext}, resolving the following set from either the pre-built
 * `followingIdsSet` or the raw `followingIds` array (exactly as the pre-refactor
 * orchestrator did) and coercing `showSensitiveContent` to a strict boolean.
 */
export function buildSignalContext(
  userId: string | undefined,
  context: CalculatePostScoreContext,
): SignalContext {
  return {
    userId,
    followingIdsSet: context.followingIdsSet ?? new Set(context.followingIds || []),
    userBehavior: context.userBehavior,
    behaviorSets: context.behaviorSets,
    authorFollowerCounts: context.authorFollowerCounts,
    showSensitiveContent: context.showSensitiveContent === true,
    viewerLanguages: context.viewerLanguages,
    feedSettings: context.feedSettings,
    engagementScoreCache: context.engagementScoreCache,
    enabledSignals: context.enabledSignals,
    seenPostIdsSet: context.seenPostIdsSet,
    authorVerified: context.authorVerified,
    networkEngagerCounts: context.networkEngagerCounts,
    mutualIdsSet: context.mutualIdsSet,
    dwellAverages: context.dwellAverages,
    viewerRecentTopics: context.viewerRecentTopics,
    authorStarterPackScores: context.authorStarterPackScores,
  };
}
