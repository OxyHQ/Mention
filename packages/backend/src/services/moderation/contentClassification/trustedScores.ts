/**
 * The SINGLE provenance rule for trusting a post's content-classification scores
 * in ranking (and, from Phase 4, the discovery gate).
 *
 * The Post schema seeds a DEFAULT `scores` of all-zeros on every new document, so
 * "scores present" is NOT proof they were ever computed — a post that was never
 * scored still carries `quality: 0`, which must NOT be read as "very low quality".
 * A score object is therefore trusted ONLY when it has a real provenance marker:
 *
 *   - `status === 'classified'` → the async AI Stage-B enrichment wrote real
 *     scores, OR
 *   - `version >= BASELINE_CLASSIFIER_VERSION` → the CURRENT deterministic Stage-A
 *     baseline actually computed and wrote these scores.
 *
 * Anything else (the default placeholder, or a baseline stamped by an OLD ruleset
 * version) returns `null` — "no usable signal" — so every consumer stays neutral
 * and the feed can never empty merely because scores are absent or stale.
 *
 * This module is the ONE place this rule lives; `FeedRankingService` and the
 * discovery gate both call it so they can never diverge.
 */

import type { PostClassificationScores, PostClassification } from '@mention/shared-types';
import { BASELINE_CLASSIFIER_VERSION } from '../BaselineContentClassifier';

/** The minimal post shape this rule reads: a (possibly partial/absent) classification subdoc. */
export interface TrustedScoresInput {
  postClassification?: Partial<PostClassification> | null;
}

/** A finite number within the inclusive 0..1 range every score field must satisfy. */
function inUnitRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Resolve a post's classification scores when — and only when — they are safe to
 * use, per the provenance rule above. Every one of the six score fields must be a
 * finite number in `[0, 1]`; a single bad/missing field disqualifies the whole
 * object (treated as absent → neutral) rather than letting a malformed value skew
 * a consumer.
 *
 * @returns the validated {@link PostClassificationScores}, or `null` when the
 *   signal must be ignored.
 */
export function readTrustedScores(
  post: TrustedScoresInput | null | undefined,
): PostClassificationScores | null {
  const classification = post?.postClassification;
  if (!classification) {
    return null;
  }

  const isClassified = classification.status === 'classified';
  const version = classification.version;
  const isCurrentBaseline = typeof version === 'number' && version >= BASELINE_CLASSIFIER_VERSION;
  if (!isClassified && !isCurrentBaseline) {
    return null;
  }

  const scores = classification.scores;
  if (!scores || typeof scores !== 'object') {
    return null;
  }

  if (
    !inUnitRange(scores.spam) ||
    !inUnitRange(scores.toxicity) ||
    !inUnitRange(scores.quality) ||
    !inUnitRange(scores.constructiveness) ||
    !inUnitRange(scores.controversy) ||
    !inUnitRange(scores.negativity)
  ) {
    return null;
  }

  return scores;
}
