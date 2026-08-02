import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MtnConfig } from '@mention/shared-types';

/**
 * Security-hardening tests for `applyImpressionSignals`.
 *
 * Feed impression telemetry is CLIENT-controlled, so its dwell duration is an
 * untrusted ranking input. These tests pin the three anti-manipulation
 * guarantees:
 *   (a) an absurd `durationMs` is CLAMPED to `MtnConfig.preferences.maxDwellMs`
 *       before it folds into the post's rolling dwell average,
 *   (b) dwell is recorded AT MOST ONCE per (post, viewer) — a repeat impression
 *       (deduped view returns `false`) does NOT pump the average, and
 *   (c) a viewer's OWN post never records dwell or skip/view learning
 *       (self-pumping guard).
 *
 * The Post model + the view/dwell/preference services are mocked so each call's
 * arguments can be asserted directly.
 */

let postDoc: { oxyUserId?: string } | null = { oxyUserId: 'author' };
/** The post's new total when the view counted; null when it did not. */
let dedupedViewResult: number | null = 1;

const findOne = vi.fn((_filter?: unknown, _projection?: unknown) => ({
  lean: () => Promise.resolve(postDoc),
}));
const recordDedupedView = vi.fn((_postId: string, _viewerId: string) => Promise.resolve(dedupedViewResult));
const recordDwell = vi.fn((_postId: string, _durationMs: number) => Promise.resolve());
const recordInteraction = vi.fn(
  (_userId: string, _postId: string, _signal: string, _opts: unknown) => Promise.resolve(),
);

vi.mock('../models/Post', () => ({
  Post: { findOne: (filter?: unknown, projection?: unknown) => findOne(filter, projection) },
}));

vi.mock('../services/feedViewCounter', () => ({
  recordDedupedView: (postId: string, viewerId: string) => recordDedupedView(postId, viewerId),
  isPostEligibleForViewTelemetry: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../services/dwellAggregate', () => ({
  recordDwell: (postId: string, durationMs: number) => recordDwell(postId, durationMs),
}));

vi.mock('../services/UserPreferenceService', () => ({
  userPreferenceService: {
    recordInteraction: (userId: string, postId: string, signal: string, opts: unknown) =>
      recordInteraction(userId, postId, signal, opts),
  },
}));

// `trackFeedInteraction` reaches this model through a dynamic import (circular
// dependency at module load), which `vi.mock` intercepts all the same.
const createFeedInteraction = vi.fn((_doc: unknown) => Promise.resolve({}));
vi.mock('../models/FeedInteraction', () => ({
  FeedInteraction: { create: (doc: unknown) => createFeedInteraction(doc) },
}));

import { applyImpressionSignals, trackFeedInteraction } from '../mtn/feed/FeedInteractionTracker';

const POST_ID = new mongoose.Types.ObjectId('5f0000000000000000000001').toString();

function impression(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'viewer',
    feedDescriptor: 'for_you',
    postUri: POST_ID,
    event: 'impression' as const,
    timestamp: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  postDoc = { oxyUserId: 'author' };
  dedupedViewResult = 1;
  vi.clearAllMocks();
});

describe('applyImpressionSignals — dwell clamping', () => {
  it('clamps an absurd client durationMs to MtnConfig.preferences.maxDwellMs', async () => {
    await applyImpressionSignals(impression({ durationMs: 999_999_999 }));
    expect(recordDwell).toHaveBeenCalledTimes(1);
    expect(recordDwell).toHaveBeenCalledWith(POST_ID, MtnConfig.preferences.maxDwellMs);
  });

  it('passes a sane durationMs through unchanged', async () => {
    await applyImpressionSignals(impression({ durationMs: 4000 }));
    expect(recordDwell).toHaveBeenCalledWith(POST_ID, 4000);
  });
});

describe('applyImpressionSignals — dedupe (record dwell once per post/viewer)', () => {
  it('does NOT record dwell when the view was already counted (duplicate impression)', async () => {
    dedupedViewResult = null; // second impression: recordDedupedView reports no new view
    await applyImpressionSignals(impression({ durationMs: 4000 }));
    expect(recordDedupedView).toHaveBeenCalledTimes(1);
    expect(recordDwell).not.toHaveBeenCalled();
  });

  it('records dwell only on the first (newly-counted) view', async () => {
    dedupedViewResult = 1;
    await applyImpressionSignals(impression({ durationMs: 4000 }));
    expect(recordDwell).toHaveBeenCalledTimes(1);
  });
});

/**
 * The view count travels back to the reporting client, which is the only way a
 * screen showing a post can learn about the view IT just caused: every gate that
 * decides whether an impression counts (dedupe window, self-view guard,
 * eligibility) lives on this side, so a client-side increment would be wrong in
 * precisely the cases the server declined.
 */
describe('applyImpressionSignals — the counted total travels back', () => {
  it('returns the post new total when the view counted', async () => {
    dedupedViewResult = 42;
    await expect(applyImpressionSignals(impression({ durationMs: 4000 }))).resolves.toBe(42);
  });

  it('returns null for a repeat impression inside the dedupe window', async () => {
    dedupedViewResult = null;
    await expect(applyImpressionSignals(impression({ durationMs: 4000 }))).resolves.toBeNull();
  });

  it('returns null for the viewer own post (self-view guard)', async () => {
    postDoc = { oxyUserId: 'viewer' };
    dedupedViewResult = 42; // Would be reported if the guard did not short-circuit.
    await expect(applyImpressionSignals(impression({ durationMs: 4000 }))).resolves.toBeNull();
  });

  it('returns null for an ineligible post', async () => {
    postDoc = null;
    await expect(applyImpressionSignals(impression({ durationMs: 4000 }))).resolves.toBeNull();
  });

  it('returns null for a non-local postUri', async () => {
    await expect(
      applyImpressionSignals(impression({ postUri: 'https://remote/notlocal' })),
    ).resolves.toBeNull();
  });
});

describe('applyImpressionSignals — self-authored guard', () => {
  it('records no dwell, no view, and no preference learning for the viewer own post', async () => {
    postDoc = { oxyUserId: 'viewer' }; // author === viewer
    await applyImpressionSignals(impression({ durationMs: 4000 }));
    expect(recordDedupedView).not.toHaveBeenCalled();
    expect(recordDwell).not.toHaveBeenCalled();
    expect(recordInteraction).not.toHaveBeenCalled();
  });

  it('still learns from another author post', async () => {
    postDoc = { oxyUserId: 'author' };
    await applyImpressionSignals(impression({ durationMs: 4000 }));
    expect(recordInteraction).toHaveBeenCalledTimes(1);
  });
});

describe('applyImpressionSignals — eligibility', () => {
  it('is a no-op for a non-ObjectId postUri', async () => {
    await applyImpressionSignals(impression({ postUri: 'https://remote/notlocal' }));
    expect(findOne).not.toHaveBeenCalled();
    expect(recordDwell).not.toHaveBeenCalled();
  });

  it('is a no-op when the post is not eligible (missing / not public+published)', async () => {
    postDoc = null;
    await applyImpressionSignals(impression({ durationMs: 4000 }));
    expect(recordDedupedView).not.toHaveBeenCalled();
    expect(recordDwell).not.toHaveBeenCalled();
  });
});

/**
 * `trackFeedInteraction` is the only caller of `applyImpressionSignals`, so the
 * count is worth nothing unless it survives that hop. It used to detach the call
 * entirely (a floating promise with a `.catch()`), which is why the value existed
 * server-side and never left the process.
 */
describe('trackFeedInteraction — propagating the counted total', () => {
  it('returns the counted total for an impression', async () => {
    dedupedViewResult = 42;
    await expect(trackFeedInteraction(impression({ durationMs: 4000 }))).resolves.toBe(42);
    expect(createFeedInteraction).toHaveBeenCalledTimes(1);
  });

  it('returns null for a non-impression event, which counts no view', async () => {
    dedupedViewResult = 42; // Would leak out if the event branch were ignored.
    await expect(trackFeedInteraction(impression({ event: 'click' as const }))).resolves.toBeNull();
    expect(recordDedupedView).not.toHaveBeenCalled();
  });

  it('still records the analytics row, and reports no count, when the signals throw', async () => {
    // The impression side effects are best-effort: a failure there must not fail
    // the interaction record, and must not invent a count for the response.
    recordDedupedView.mockRejectedValueOnce(new Error('redis down'));
    await expect(trackFeedInteraction(impression({ durationMs: 4000 }))).resolves.toBeNull();
    expect(createFeedInteraction).toHaveBeenCalledTimes(1);
  });
});
