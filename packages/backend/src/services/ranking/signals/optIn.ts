/**
 * OPT-IN (Phase 2b) ranking signals.
 *
 * Each scorer below returns a MULTIPLIER and is DEFAULT-NEUTRAL — exactly 1.0
 * when its input data is absent or below its provenance bar. They are composed
 * by {@link composeOptInSignals} ONLY for the signals a feed definition enabled
 * (`ctx.enabledSignals`), so preset feeds (which enable none) are unaffected.
 * Config lives in `MtnConfig.ranking.optInSignals` — no magic numbers here.
 *
 * The composite is registered as the SINGLE opt-in registry entry (see
 * `registry.ts`): the pre-refactor score multiplied the opt-in product as ONE
 * factor at the tail (`finalScore = coreProduct × optInComposite`), and folding
 * these here — rather than as separate registry factors — keeps the score
 * bit-for-bit identical (IEEE-754 multiplication is not associative). This array
 * is also the extension point for future opt-in signals (Phase 4).
 */

import { MtnConfig } from '@mention/shared-types';
import type { RankablePost, RankingUserBehavior, SignalContext } from '../signalContext';
import { getCanonicalTopics, getClassifiedConstructiveness } from './classification';
import type { RankingSignal } from './types';

const R = MtnConfig.ranking;

/**
 * `mediaBoost` — favor posts that carry media (image / video / gif). Neutral
 * (1.0) for a text-only post; the configured boost when the post has at least
 * one media attachment (or is an image/video post by type).
 */
export function mediaBoost(post: RankablePost): number {
  const media = post?.content?.media;
  const hasMediaArray = Array.isArray(media) && media.length > 0;
  const type = typeof post?.type === 'string' ? post.type.toLowerCase() : '';
  const isMediaType = type === 'image' || type === 'video' || type === 'gif';
  return hasMediaArray || isMediaType ? R.optInSignals.mediaBoost.boost : 1.0;
}

/**
 * `positivity` — favor positive-sentiment posts. PROVENANCE-GATED: sentiment is
 * an AI Stage-B field, so it is only trusted when `status === 'classified'`.
 * Returns the configured boost for a classified `positive` post, `1.0`
 * otherwise (unclassified, or any non-positive sentiment).
 */
export function positivityBoost(post: RankablePost): number {
  const classification = post?.postClassification;
  if (!classification || classification.status !== 'classified') {
    return 1.0;
  }
  return classification.sentiment === 'positive' ? R.optInSignals.positivity.boost : 1.0;
}

/**
 * `conversational` — favor constructive / conversational posts. Prefers the
 * classified `constructiveness` score (provenance-gated, 0..1); when that is
 * absent it falls back to the reply ratio derived from `stats`
 * (comments / (comments + likes + boosts)). The multiplier is
 * `1 + signal * (maxBoost - 1)`, so a signal of 0 → neutral `1.0`, a signal of
 * 1 → `maxBoost`. Neutral when there is neither a constructiveness score nor
 * any engagement to derive a ratio from.
 */
export function conversationalBoost(post: RankablePost): number {
  const { maxBoost } = R.optInSignals.conversational;

  const constructiveness = getClassifiedConstructiveness(post);
  if (constructiveness !== null) {
    return 1 + constructiveness * (maxBoost - 1);
  }

  const stats = post?.stats || {};
  const comments = stats.commentsCount || 0;
  const denom = comments + (stats.likesCount || 0) + (stats.boostsCount || 0);
  if (denom <= 0) {
    return 1.0;
  }
  const replyRatio = comments / denom;
  return 1 + replyRatio * (maxBoost - 1);
}

/**
 * `coldStartBoost` — a small DISCOVERY lift for content that would otherwise
 * struggle to accrue engagement: brand-new posts (within the configured window)
 * OR posts from low-follower "cold-start" authors. Neutral (1.0) for an
 * established post whose author is well-followed (or whose follower count is
 * unknown), so it never penalizes.
 *
 * @param followerCount - the post author's follower count, or `undefined`.
 */
export function coldStartBoost(post: RankablePost, followerCount: number | undefined): number {
  const { boost, windowMs, newAuthorFollowerThreshold } = R.optInSignals.coldStartBoost;

  const createdMs = new Date(post?.createdAt ?? NaN).getTime();
  const isFreshPost = Number.isFinite(createdMs) && Date.now() - createdMs <= windowMs;

  const isColdAuthor =
    typeof followerCount === 'number' &&
    Number.isFinite(followerCount) &&
    followerCount >= 0 &&
    followerCount < newAuthorFollowerThreshold;

  return isFreshPost || isColdAuthor ? boost : 1.0;
}

/**
 * `penalizeSeen` — a SOFT de-prioritization (not a hard exclude) of posts the
 * viewer has already seen: the configured penalty (< 1) when the post id is in
 * the viewer's seen set, `1.0` otherwise (or when there is no seen set). Lets a
 * seen post still surface but yield to fresh content.
 */
export function penalizeSeen(post: RankablePost, seenPostIds: Set<string> | undefined): number {
  if (!seenPostIds || seenPostIds.size === 0) {
    return 1.0;
  }
  const id = post?._id != null ? String(post._id) : '';
  return id && seenPostIds.has(id) ? R.optInSignals.penalizeSeen.penalty : 1.0;
}

/**
 * `verifiedBoost` — a small lift for verified authors. Neutral (1.0) when the
 * verified map is absent, the author is not in it, or the author is not
 * verified; the configured boost when `authorVerified.get(authorId) === true`.
 */
export function verifiedBoost(post: RankablePost, authorVerified: Map<string, boolean> | undefined): number {
  if (!authorVerified) {
    return 1.0;
  }
  const authorId = post?.oxyUserId ? String(post.oxyUserId) : '';
  return authorId && authorVerified.get(authorId) === true ? R.optInSignals.verifiedBoost.boost : 1.0;
}

/**
 * `dwellTime` — favor posts that hold attention. Reads the post's average
 * impression dwell (ms) from the request-scoped dwell map. Neutral (1.0) when
 * there is no dwell data or the average is below `thresholdMs`; otherwise a
 * lift that scales LINEARLY from `boost` (at the threshold) toward `maxBoost`
 * (reached at 2× the threshold) and clamps there — so an extreme sample can
 * never run away with the score.
 */
export function dwellTimeBoost(post: RankablePost, dwellAverages: Map<string, number> | undefined): number {
  if (!dwellAverages) {
    return 1.0;
  }
  const id = post?._id != null ? String(post._id) : '';
  const avg = id ? dwellAverages.get(id) : undefined;
  const { thresholdMs, boost, maxBoost } = R.optInSignals.dwellTime;
  if (typeof avg !== 'number' || !Number.isFinite(avg) || avg < thresholdMs) {
    return 1.0;
  }
  const over = (avg - thresholdMs) / thresholdMs; // 0 at threshold, 1 at 2× threshold
  const scaled = boost + over * (maxBoost - boost);
  return Math.min(maxBoost, Math.max(boost, scaled));
}

/**
 * `socialProof` — favor posts that people in the viewer's network (following ∪
 * mutuals) liked or boosted. Reads the request-scoped `postId → distinct
 * network-engager count` map. Neutral (1.0) when there is no data or the count
 * is 0; otherwise `1 + count * perEngager`, clamped to `maxBoost` so a viral
 * post can't run away with the score.
 */
export function socialProofBoost(
  post: RankablePost,
  networkEngagerCounts: Map<string, number> | undefined,
): number {
  if (!networkEngagerCounts) {
    return 1.0;
  }
  const id = post?._id != null ? String(post._id) : '';
  const count = id ? networkEngagerCounts.get(id) : undefined;
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
    return 1.0;
  }
  const { perEngager, maxBoost } = R.optInSignals.socialProof;
  return Math.min(maxBoost, 1 + count * perEngager);
}

/**
 * `reciprocityBoost` — favor authors the viewer MUTUALLY engages with: an
 * author who is BOTH a mutual follow (in `mutualIdsSet`) AND a learned
 * `preferredAuthor` at or above `minAuthorWeight`. Neutral (1.0) when there are
 * no mutuals, no learned behavior, the author is not a mutual, or the author is
 * not a (sufficiently-weighted) preferred author.
 */
export function reciprocityBoost(
  post: RankablePost,
  userBehavior: RankingUserBehavior | undefined,
  mutualIdsSet: Set<string> | undefined,
): number {
  if (!mutualIdsSet || mutualIdsSet.size === 0 || !userBehavior?.preferredAuthors) {
    return 1.0;
  }
  const authorId = post?.oxyUserId ? String(post.oxyUserId) : '';
  if (!authorId || !mutualIdsSet.has(authorId)) {
    return 1.0;
  }
  const { boost, minAuthorWeight } = R.optInSignals.reciprocityBoost;
  const preference = userBehavior.preferredAuthors.find((a) => a.authorId === authorId);
  return preference && preference.weight >= minAuthorWeight ? boost : 1.0;
}

/**
 * `noveltyBoost` — an EXPLORATION lift for posts whose topics the viewer has
 * NOT recently seen, to break out of topic echo chambers. Neutral (1.0) when
 * there is no recent-topic set, the post has no topics (novelty can't be
 * judged), or ANY of the post's topics is in the recent set; the configured
 * boost when the post has topics and ALL of them are novel to the viewer.
 */
export function noveltyBoost(post: RankablePost, viewerRecentTopics: Set<string> | undefined): number {
  if (!viewerRecentTopics || viewerRecentTopics.size === 0) {
    return 1.0;
  }
  const names = getCanonicalTopics(post)
    .map((t) => (typeof t.name === 'string' ? t.name.toLowerCase() : ''))
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    return 1.0;
  }
  const seenAny = names.some((name) => viewerRecentTopics.has(name));
  return seenAny ? 1.0 : R.optInSignals.noveltyBoost.boost;
}

/**
 * `localBoost` (Phase 4d) — a MODEST lift for LOCAL (first-party) posts. Neutral
 * (1.0) for a federated post (one carrying a `federation` subdoc); the configured
 * boost for a local post (`federation` absent/null). Complements the
 * `federatedBoostWeight` engagement dampening — it nudges first-party content up
 * without suppressing federated discovery.
 */
export function localBoost(post: RankablePost): number {
  const isLocal = post?.federation === undefined || post?.federation === null;
  return isLocal ? R.optInSignals.localBoost.boost : 1.0;
}

/**
 * `languageMismatchPenalty` (Phase 4c) — a SOFT downrank (never a filter) of
 * off-language DISCOVERY posts. Applies the configured penalty (< 1) ONLY when:
 *   - the post is a DISCOVERY candidate (`post._discovery === true` — trusted-lane
 *     posts are never marked, so they are NEVER penalized),
 *   - the viewer's account languages are KNOWN (non-empty), AND
 *   - the post's `postClassification.languages` are KNOWN and DISJOINT from them.
 * Neutral (1.0) in every other case (unmarked post, unknown viewer languages,
 * unclassified post, or any language overlap). Both language lists are tiny
 * (≤ 3 codes), so the overlap check is a cheap nested scan — no Set needed.
 */
export function languageMismatchPenalty(post: RankablePost, viewerLanguages: string[] | undefined): number {
  if (post?._discovery !== true) {
    return 1.0;
  }
  if (!viewerLanguages || viewerLanguages.length === 0) {
    return 1.0;
  }
  const postLanguages = post?.postClassification?.languages;
  if (!Array.isArray(postLanguages) || postLanguages.length === 0) {
    return 1.0;
  }
  const viewerSet = viewerLanguages.map((l) => l.toLowerCase());
  const overlaps = postLanguages.some((lang) => viewerSet.includes(lang.toLowerCase()));
  return overlaps ? 1.0 : R.optInSignals.languageMismatchPenalty.penalty;
}

/**
 * A single opt-in scorer: its enable key plus the `(post, ctx)` adapter that
 * pulls the scorer's inputs from the resolved {@link SignalContext}.
 */
interface OptInScorer {
  id: string;
  score(post: RankablePost, ctx: SignalContext): number;
}

/**
 * The opt-in scorers in the FIXED order the composite multiplies them. This
 * order is load-bearing for bit-exact reproduction of the pre-refactor score —
 * do not reorder without re-baselining the golden master.
 */
export const OPT_IN_SIGNALS: readonly OptInScorer[] = [
  { id: 'mediaBoost', score: (post) => mediaBoost(post) },
  { id: 'positivity', score: (post) => positivityBoost(post) },
  { id: 'conversational', score: (post) => conversationalBoost(post) },
  { id: 'coldStartBoost', score: (post, ctx) => coldStartBoost(post, ctx.authorFollowerCounts?.get(String(post.oxyUserId))) },
  { id: 'penalizeSeen', score: (post, ctx) => penalizeSeen(post, ctx.seenPostIdsSet) },
  { id: 'verifiedBoost', score: (post, ctx) => verifiedBoost(post, ctx.authorVerified) },
  { id: 'dwellTime', score: (post, ctx) => dwellTimeBoost(post, ctx.dwellAverages) },
  { id: 'socialProof', score: (post, ctx) => socialProofBoost(post, ctx.networkEngagerCounts) },
  { id: 'reciprocityBoost', score: (post, ctx) => reciprocityBoost(post, ctx.userBehavior, ctx.mutualIdsSet) },
  { id: 'noveltyBoost', score: (post, ctx) => noveltyBoost(post, ctx.viewerRecentTopics) },
  // Phase 4 discovery signals — appended at the END so existing opt-in ordering
  // (and the golden-master product) is unchanged. Both fire only when explicitly
  // enabled (DORMANT until Phase 5), so preset ranking is unaffected.
  { id: 'localBoost', score: (post) => localBoost(post) },
  { id: 'languageMismatchPenalty', score: (post, ctx) => languageMismatchPenalty(post, ctx.viewerLanguages) },
];

/**
 * Compose the enabled opt-in signal multipliers for a post. Returns exactly
 * `1.0` when the definition enabled no opt-in signals (the preset default), so
 * this is a no-op for For You / Explore / Videos / Media. Each enabled scorer is
 * still individually default-neutral when its data is missing. Multiplies in the
 * fixed {@link OPT_IN_SIGNALS} order (left fold from 1.0) to match the
 * pre-refactor behavior byte-for-byte.
 */
export function composeOptInSignals(post: RankablePost, ctx: SignalContext): number {
  const enabled = ctx.enabledSignals;
  if (!enabled || enabled.size === 0) {
    return 1.0;
  }
  let multiplier = 1.0;
  for (const signal of OPT_IN_SIGNALS) {
    if (enabled.has(signal.id)) {
      multiplier *= signal.score(post, ctx);
    }
  }
  return multiplier;
}

export const optInSignal: RankingSignal = {
  id: 'optIn',
  group: 'personalization',
  optIn: true,
  score: composeOptInSignals,
};
