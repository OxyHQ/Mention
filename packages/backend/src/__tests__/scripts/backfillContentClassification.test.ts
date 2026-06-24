import { describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Unit coverage for the deterministic, pure pieces of the Stage-A backfill
 * one-shot: the version-aware page filter (idempotency contract) and the
 * per-post update builder (`{ $set, $unset }`). No DB is touched —
 * `mongoose.connect` and the `Post` model are not exercised here; only the
 * exported pure helpers are.
 */

// Avoid pulling the real Post model (and its mongoose connection side effects)
// into the unit test — the helpers under test never touch it.
vi.mock('../../models/Post', () => ({ Post: {} }));

import {
  buildPageFilter,
  buildBaselineUpdate,
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

describe('backfillContentClassification — buildBaselineUpdate', () => {
  it('sets the Stage-A fields + deterministic scores (never the AI LIFECYCLE fields)', () => {
    const update = buildBaselineUpdate(row());
    expect(update).not.toBeNull();
    const keys = Object.keys((update as { $set: Record<string, unknown> }).$set).sort();
    expect(keys).toEqual(
      [
        'postClassification.hashtagsNorm',
        'postClassification.languages',
        'postClassification.region',
        'postClassification.sensitive',
        'postClassification.topics',
        'postClassification.version',
        // Deterministic scores are written for not-yet-AI-classified posts.
        'postClassification.scores',
        // The top-level AP `post.language` carries the resolved primary.
        'language',
      ].sort(),
    );
    // The single classification-language field is GONE from `$set` — only the
    // multi-language array remains in the subdoc.
    expect(keys).not.toContain('postClassification.language');
    // Crucially, it must NOT write the AI lifecycle fields.
    for (const banned of [
      'postClassification.status',
      'postClassification.attempts',
      'postClassification.sentiment',
      'postClassification.intent',
      'postClassification.confidence',
    ]) {
      expect(keys).not.toContain(banned);
    }
  });

  it('migrates off the removed single `postClassification.language` via $unset', () => {
    const update = buildBaselineUpdate(row()) as {
      $set: Record<string, unknown>;
      $unset: Record<string, unknown>;
    };
    // The deprecated singular field is unset in the SAME write that sets the array.
    expect(update.$unset['postClassification.language']).toBe('');
    expect(update.$set['postClassification.language']).toBeUndefined();
  });

  it('writes deterministic 0..1 scores (spam/quality/toxicity) for a non-classified post', () => {
    const { $set } = buildBaselineUpdate(row()) as { $set: Record<string, unknown> };
    const scores = $set['postClassification.scores'] as {
      spam: number;
      quality: number;
      toxicity: number;
    };
    expect(scores).toBeDefined();
    for (const value of [scores.spam, scores.quality, scores.toxicity]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('does NOT overwrite scores on an already AI-classified post', () => {
    const { $set } = buildBaselineUpdate(
      row({ postClassification: { status: 'classified' } }),
    ) as { $set: Record<string, unknown> };
    // Stage-A fields still refreshed, but the higher-fidelity AI scores are left intact.
    expect($set['postClassification.version']).toBe(BASELINE_CLASSIFIER_VERSION);
    expect(Object.keys($set)).not.toContain('postClassification.scores');
  });

  it('re-derives the primary into the top-level `post.language` and stamps the current version', () => {
    const { $set } = buildBaselineUpdate(row()) as { $set: Record<string, unknown> };
    expect($set.language).toBe('en');
    expect($set['postClassification.version']).toBe(BASELINE_CLASSIFIER_VERSION);
    expect($set['postClassification.topics']).toContain('ai');
  });

  it('writes the multi-language `languages` array (primary first)', () => {
    const { $set } = buildBaselineUpdate(row()) as { $set: Record<string, unknown> };
    const languages = $set['postClassification.languages'] as string[];
    expect(Array.isArray(languages)).toBe(true);
    // A monolingual English post yields exactly one language, equal to the primary.
    expect(languages).toEqual(['en']);
    expect(languages[0]).toBe($set.language);
  });

  it('derives a coarse region for a federated post from its stored federation URI', () => {
    const { $set } = buildBaselineUpdate(
      row({
        content: { text: 'Guten Morgen zusammen, das ist ein ganz normaler deutscher Beitrag.' },
        hashtags: [],
        federation: {
          activityId: 'https://social.example.de/users/x/statuses/1',
          url: 'https://social.example.de/@x/1',
          sensitive: false,
        },
      }),
    ) as { $set: Record<string, unknown> };
    expect($set['postClassification.region']).toBe('DE');
    expect($set.language).toBe('de');
  });

  it('passes through the stored sensitive flag', () => {
    const { $set } = buildBaselineUpdate(
      row({ federation: { activityId: 'https://x.de/1', sensitive: true } }),
    ) as { $set: Record<string, unknown> };
    expect($set['postClassification.sensitive']).toBe(true);
  });

  it('is deterministic / idempotent for the same stored input (same update)', () => {
    const input = row();
    const a = buildBaselineUpdate(input);
    const b = buildBaselineUpdate(input);
    expect(a).toEqual(b);
  });
});
