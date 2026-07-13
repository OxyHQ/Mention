/**
 * Content-classification readers shared across the ranking signals.
 *
 * These wrap the single provenance rule in
 * `services/contentClassification/trustedScores.ts` (only trust scores that are
 * AI-`classified` OR stamped at the current baseline `version`) and normalize a
 * post's topics into one list. Every reader is neutral-when-absent: a post with
 * no usable classification yields `null` / `[]`, so no signal is ever penalized
 * or boosted for lacking classification and the feed can never empty.
 */

import type { PostClassificationScores } from '@mention/shared-types';
import { readTrustedScores } from '../../contentClassification/trustedScores';
import type { RankablePost } from '../signalContext';

/**
 * Resolve a post's content-classification scores when they are safe to use for
 * ranking — from EITHER source:
 *   - the deterministic Stage-A BASELINE (any non-`classified` status that has
 *     been baselined to the current ruleset `version`), or
 *   - the async AI Stage-B enrichment (status `classified`).
 *
 * This is what lets the SAME ranking path downrank spam/low-quality posts
 * deterministically before any AI runs; when the AI batch later overwrites
 * `scores` with higher-fidelity values (and flips status to `classified`), this
 * transparently uses those instead.
 *
 * PROVENANCE GUARD — why we don't just trust `scores` being present: the Post
 * schema seeds a DEFAULT `scores` of all-zeros on every new doc, so a post that
 * was never actually scored carries `quality:0` (which would otherwise be read
 * as "very low quality"). The shared {@link readTrustedScores} therefore only
 * honors scores that have a real provenance marker (`status === 'classified'`
 * OR `version >= BASELINE_CLASSIFIER_VERSION`). A post with the default
 * placeholder is treated as having NO usable signal.
 *
 * @returns the validated scores, or `null` when the signal must be ignored.
 */
export function getClassifiedScores(post: RankablePost): PostClassificationScores | null {
  // The provenance + validation rule lives in ONE shared module so ranking and
  // the discovery gate can never diverge on what counts as a trusted score.
  return readTrustedScores(post);
}

/**
 * The canonical resolved topics for a post, PREFERRING the registry-linked
 * `postClassification.topicRefs` (each entry carries `name` + resolved
 * `topicId`) and FALLING BACK to the slug-only `postClassification.topics`
 * (each slug normalized to `{ name }`). The slug list is the rule-based Stage-A
 * baseline that every classified post carries; the richer `topicRefs` is the
 * Stage-B AI form. Returns `[]` when neither is present so every topic signal is
 * NEUTRAL for a topic-less post — the feed never empties when topics are absent.
 *
 * Both shapes expose the `name` readers need; only `topicRefs` carries
 * `topicId`, so topicId-based personalization naturally no-ops on slug-only
 * posts (just like an unresolved registry entry). This is the single
 * normalization point: the rest of the ranking code reads one list.
 */
export function getCanonicalTopics(
  post: RankablePost,
): Array<{ topicId?: unknown; name?: unknown }> {
  const refs = post?.postClassification?.topicRefs;
  if (Array.isArray(refs) && refs.length > 0) {
    return refs;
  }
  const topics = post?.postClassification?.topics;
  if (Array.isArray(topics) && topics.length > 0) {
    return topics.map((name) => ({ name }));
  }
  return [];
}

/**
 * Resolve a post's classified `constructiveness` score when it is safe to use
 * for ranking. Mirrors the provenance guard of {@link getClassifiedScores}
 * (AI-classified OR baselined to the current ruleset version) but reads ONLY
 * `constructiveness` (it is orthogonal to the spam/toxicity/quality triad).
 * Returns the score in `[0, 1]`, or `null` when there is no usable signal so the
 * caller falls back to a neutral behavior.
 */
export function getClassifiedConstructiveness(post: RankablePost): number | null {
  // Same provenance rule as the spam/toxicity/quality triad — share the single
  // validator and read the one orthogonal field off the trusted object.
  const scores = readTrustedScores(post);
  return scores ? scores.constructiveness : null;
}
