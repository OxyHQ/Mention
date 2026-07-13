/**
 * `negativePenalty` signal — the multiplicative downranks/exclusions: sensitive
 * hard-zero (viewer-conditional), hidden/muted/blocked authors, hidden topics,
 * and the content-level AI spam/toxicity safety penalty. Neutral (1.0) for a
 * clean post and viewer. Occupies the `diversity` explainer group (the in-score
 * diversity pass was removed as dead code in the Phase 3 refactor).
 */

import { MtnConfig } from '@mention/shared-types';
import { isSensitivePost } from '../../../mtn/feed/feedSafety';
import {
  buildBehaviorSets,
  type BehaviorSets,
  type RankablePost,
  type RankingUserBehavior,
  type SignalContext,
} from '../signalContext';
import { getCanonicalTopics, getClassifiedScores } from './classification';
import type { RankingSignal } from './types';

const R = MtnConfig.ranking;

/**
 * AI SAFETY penalty from the classified spam / toxicity scores.
 *
 * Returns a multiplier in `(0, 1]`: exactly `1.0` (neutral) when there is no
 * usable AI signal, or when neither spam nor toxicity crosses its configured
 * threshold; the strong `highRiskPenalty` (~0.1) when EITHER is high, pushing
 * the flagged post effectively out of the feed without hard-excluding it. This
 * is folded INTO the negative penalty, so it composes multiplicatively with
 * hidden/muted/blocked/hidden-topic penalties.
 */
function aiSafetyPenalty(post: RankablePost): number {
  const scores = getClassifiedScores(post);
  if (!scores) {
    return 1.0; // No usable AI signal → neutral.
  }

  const { spamThreshold, toxicityThreshold, highRiskPenalty } = R.aiQuality.safety;
  if (scores.spam >= spamThreshold || scores.toxicity >= toxicityThreshold) {
    return highRiskPenalty;
  }

  return 1.0;
}

/**
 * Calculate negative signals penalty.
 *
 * Combines three kinds of penalty, multiplicatively:
 * 1. SENSITIVE/NSFW hard exclusion — a sensitive/NSFW post ({@link isSensitivePost})
 *    returns `0`, fully removing it from the ranked feeds. VIEWER-CONDITIONAL:
 *    applied only when the viewer is in safe-for-work mode (`showSensitiveContent`
 *    is false/undefined). When the viewer has opted in, a sensitive post is NOT
 *    zeroed and ranks normally (still carrying its sensitive flag for client-side
 *    blur / content warnings). NEUTRAL for clean posts.
 * 2. VIEWER negative signals — hidden / muted / blocked authors and hidden topics
 *    (require a logged-in viewer with behavior data).
 * 3. CONTENT AI-safety penalty — high spam / toxicity from the classified scores
 *    ({@link aiSafetyPenalty}). Viewer-INDEPENDENT, so it applies on EVERY path
 *    (including anonymous) — but is exactly `1.0` (neutral) for any post that
 *    isn't AI-classified with high-risk scores, so the feed never empties.
 */
export function negativePenalty(
  post: RankablePost,
  userId: string | undefined,
  userBehavior: RankingUserBehavior | undefined,
  behaviorSets?: BehaviorSets,
  showSensitiveContent: boolean = false,
): number {
  // Sensitive/NSFW is a HARD exclusion from ranked feeds for safe-for-work
  // viewers — short-circuit to 0 so the post can never surface. When the viewer
  // has explicitly opted in to sensitive content, skip this guard so the post
  // ranks normally (it keeps its sensitive flag for client-side blur/CW).
  if (!showSensitiveContent && isSensitivePost(post)) {
    return 0;
  }

  // Content-level AI safety penalty applies regardless of viewer/behavior.
  const safetyPenalty = aiSafetyPenalty(post);

  if (!userId || !userBehavior) {
    return safetyPenalty;
  }

  const authorId = post.oxyUserId ?? '';

  // Use pre-computed Sets if available, else create from arrays
  const sets = behaviorSets ?? buildBehaviorSets(userBehavior);
  if (!sets) {
    return safetyPenalty;
  }

  // Check if author is hidden, muted, or blocked
  if (
    sets.hiddenAuthors.has(authorId) ||
    sets.mutedAuthors.has(authorId) ||
    sets.blockedAuthors.has(authorId)
  ) {
    return 0; // Completely hide
  }

  // Check if topic is hidden (via hashtags or canonical classified topic
  // names). Topic names come from the canonical `postClassification.topicRefs`,
  // falling back to `postClassification.topics`.
  if (sets.hiddenTopics.size > 0) {
    const hasHiddenHashtag = post.hashtags?.some((tag: string) =>
      sets.hiddenTopics.has(tag.toLowerCase())
    );

    const hasHiddenClassifiedTopic = getCanonicalTopics(post).some(
      (t) => typeof t.name === 'string' && sets.hiddenTopics.has(t.name.toLowerCase()),
    );

    if (hasHiddenHashtag || hasHiddenClassifiedTopic) {
      return 0.5 * safetyPenalty; // Reduce visibility (composes with AI safety)
    }
  }

  return safetyPenalty;
}

export const negativePenaltySignal: RankingSignal = {
  id: 'negativePenalty',
  group: 'diversity',
  score: (post: RankablePost, ctx: SignalContext) =>
    negativePenalty(post, ctx.userId, ctx.userBehavior, ctx.behaviorSets, ctx.showSensitiveContent),
};
