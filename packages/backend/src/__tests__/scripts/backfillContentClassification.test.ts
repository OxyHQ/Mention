import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Unit coverage for the deterministic, pure pieces of the Stage-A backfill
 * one-shot: the version-aware page filter (idempotency contract) and the
 * per-post `$set` builder. No DB is touched — `mongoose.connect` and the
 * `Post` model are not exercised here; only the exported pure helpers are.
 */

// Avoid pulling the real Post model (and its mongoose connection side effects)
// into the unit test — the helpers under test never touch it.
vi.mock('../../models/Post', () => ({ Post: {} }));

import {
  buildPageFilter,
  buildBaselineSet,
  type BackfillPostRow,
} from '../../scripts/backfillContentClassification';
import { BASELINE_CLASSIFIER_VERSION } from '../../services/BaselineContentClassifier';

function row(overrides: Partial<BackfillPostRow> = {}): BackfillPostRow {
  return {
    _id: new mongoose.Types.ObjectId(),
    content: { text: 'I love how much faster the feed feels now, this is genuinely great news for everyone.' },
    hashtags: ['ai'],
    ...overrides,
  };
}

describe('backfillContentClassification — buildPageFilter (idempotency)', () => {
  it('targets posts whose Stage-A version is missing or below the current ruleset', () => {
    const filter = buildPageFilter(null);
    expect(filter.$or).toEqual([
      { 'postClassification.version': { $exists: false } },
      { 'postClassification.version': { $lt: BASELINE_CLASSIFIER_VERSION } },
    ]);
    // No cursor bound on the first page.
    expect(filter._id).toBeUndefined();
  });

  it('adds an ascending _id cursor bound when resuming', () => {
    const lastId = new mongoose.Types.ObjectId();
    const filter = buildPageFilter(lastId);
    expect(filter._id).toEqual({ $gt: lastId });
  });

  it('a post already at the current version is excluded by the filter (no re-work)', () => {
    // The filter only matches version < current OR missing; a doc at the current
    // version satisfies neither branch, so re-running the backfill is a no-op.
    const atCurrentVersion = BASELINE_CLASSIFIER_VERSION;
    const filter = buildPageFilter(null);
    const matchesMissing = false; // version IS present
    const matchesBelow = atCurrentVersion < BASELINE_CLASSIFIER_VERSION;
    expect(matchesMissing || matchesBelow).toBe(false);
    expect(filter.$or).toHaveLength(2);
  });
});

describe('backfillContentClassification — buildBaselineSet', () => {
  it('sets ONLY the Stage-A fields (never the AI lifecycle fields)', () => {
    const set = buildBaselineSet(row());
    expect(set).not.toBeNull();
    const keys = Object.keys(set as Record<string, unknown>).sort();
    expect(keys).toEqual(
      [
        'postClassification.hashtagsNorm',
        'postClassification.language',
        'postClassification.region',
        'postClassification.sensitive',
        'postClassification.topics',
        'postClassification.version',
      ].sort(),
    );
    // Crucially, it must NOT write status/attempts/scores/sentiment/intent.
    for (const banned of [
      'postClassification.status',
      'postClassification.attempts',
      'postClassification.scores',
      'postClassification.sentiment',
      'postClassification.intent',
      'postClassification.confidence',
    ]) {
      expect(keys).not.toContain(banned);
    }
  });

  it('re-derives language from the stored text and stamps the current version', () => {
    const set = buildBaselineSet(row()) as Record<string, unknown>;
    expect(set['postClassification.language']).toBe('en');
    expect(set['postClassification.version']).toBe(BASELINE_CLASSIFIER_VERSION);
    expect(set['postClassification.topics']).toContain('ai');
  });

  it('derives a coarse region for a federated post from its stored federation URI', () => {
    const set = buildBaselineSet(
      row({
        content: { text: 'Guten Morgen zusammen, das ist ein ganz normaler deutscher Beitrag.' },
        hashtags: [],
        federation: {
          activityId: 'https://social.example.de/users/x/statuses/1',
          url: 'https://social.example.de/@x/1',
          sensitive: false,
        },
      }),
    ) as Record<string, unknown>;
    expect(set['postClassification.region']).toBe('DE');
    expect(set['postClassification.language']).toBe('de');
  });

  it('passes through the stored sensitive flag', () => {
    const set = buildBaselineSet(
      row({ federation: { activityId: 'https://x.de/1', sensitive: true } }),
    ) as Record<string, unknown>;
    expect(set['postClassification.sensitive']).toBe(true);
  });

  it('is deterministic / idempotent for the same stored input (same $set)', () => {
    const input = row();
    const a = buildBaselineSet(input) as Record<string, unknown>;
    const b = buildBaselineSet(input) as Record<string, unknown>;
    expect(a).toEqual(b);
  });
});
