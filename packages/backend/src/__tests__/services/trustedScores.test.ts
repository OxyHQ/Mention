import { describe, it, expect } from 'vitest';
import { readTrustedScores } from '../../services/contentClassification/trustedScores';
import { BASELINE_CLASSIFIER_VERSION } from '../../services/BaselineContentClassifier';
import type { PostClassificationScores } from '@mention/shared-types';

/**
 * Parity tests for the shared provenance rule extracted from
 * `FeedRankingService.getClassifiedScores`. The behavior must be exactly:
 *   - trusted when AI-`classified` OR baselined to the CURRENT ruleset version,
 *   - `null` for the default placeholder, a stale (older) baseline version, or a
 *     malformed score object.
 */

const VALID: PostClassificationScores = {
  spam: 0.1,
  toxicity: 0.2,
  quality: 0.8,
  constructiveness: 0.5,
  controversy: 0.1,
  negativity: 0.2,
};

describe('readTrustedScores — provenance', () => {
  it('trusts an AI-classified post (no version needed)', () => {
    expect(readTrustedScores({ postClassification: { status: 'classified', scores: VALID } })).toEqual(VALID);
  });

  it('trusts a baseline stamped at the CURRENT ruleset version', () => {
    expect(
      readTrustedScores({
        postClassification: { status: 'pending', version: BASELINE_CLASSIFIER_VERSION, scores: VALID },
      }),
    ).toEqual(VALID);
  });

  it('returns null for a baseline stamped at an OLDER version (stale after the v5 bump)', () => {
    expect(
      readTrustedScores({
        postClassification: { status: 'pending', version: BASELINE_CLASSIFIER_VERSION - 1, scores: VALID },
      }),
    ).toBeNull();
  });

  it('returns null for the default placeholder (no version, not classified)', () => {
    expect(
      readTrustedScores({
        postClassification: {
          status: 'pending',
          scores: { spam: 0, toxicity: 0, quality: 0, constructiveness: 0, controversy: 0, negativity: 0 },
        },
      }),
    ).toBeNull();
  });

  it('returns null when there is no classification subdoc at all', () => {
    expect(readTrustedScores({})).toBeNull();
    expect(readTrustedScores(null)).toBeNull();
    expect(readTrustedScores(undefined)).toBeNull();
  });
});

describe('readTrustedScores — validation', () => {
  it('returns null when scores are missing on an otherwise-trusted post', () => {
    expect(readTrustedScores({ postClassification: { status: 'classified' } })).toBeNull();
  });

  it('returns null for a malformed (out-of-range / non-finite) score field', () => {
    expect(
      readTrustedScores({ postClassification: { status: 'classified', scores: { ...VALID, spam: 1.5 } } }),
    ).toBeNull();
    expect(
      readTrustedScores({ postClassification: { status: 'classified', scores: { ...VALID, quality: Number.NaN } } }),
    ).toBeNull();
    expect(
      readTrustedScores({ postClassification: { status: 'classified', scores: { ...VALID, toxicity: -0.1 } } }),
    ).toBeNull();
  });
});
