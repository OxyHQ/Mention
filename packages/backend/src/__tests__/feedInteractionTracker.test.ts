/**
 * Security-hardening tests for `applyImpressionSignals`, against REAL ROWS.
 *
 * Feed impression telemetry is CLIENT-controlled, so its dwell duration is an
 * untrusted ranking input. These pin the anti-manipulation guarantees:
 *   (a) an absurd `durationMs` is CLAMPED to `MtnConfig.preferences.maxDwellMs`
 *       before it folds into the post's rolling dwell average,
 *   (b) dwell is recorded AT MOST ONCE per (post, viewer) — a repeat impression
 *       (deduped view reports no new view) does NOT pump the average,
 *   (c) a viewer's OWN post never records dwell or skip/view learning,
 *   (d) telemetry about a post that is not a public, published local post is a
 *       no-op, whatever the client sent,
 *   (e) the counted total travels BACK to the reporting client, and only when a
 *       view really counted — every gate that decides that lives on this side,
 *       so a client-side increment would be wrong in exactly the cases the
 *       server declined.
 *
 * (c) and (d) are decided by a query, and the post it queries is a real row now.
 * Under the previous `Post.findOne` mock the eligibility answer was assigned by
 * the test (`postDoc = null`), so the visibility and status arms of that filter
 * were never executed: the suite would have passed against a lookup that fetched
 * ANY post, including a private or draft one, which is the leak the gate exists
 * to prevent. The counters downstream (Redis dwell, preference learning) stay
 * mocked — those belong to their own services, and their call arguments are the
 * observable this file is about.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MtnConfig, PostVisibility } from '@mention/shared-types';

/** Resolves to the post's new total when the view counted, `null` when it did not. */
const recordDedupedView = vi.fn(
  (_postId: string, _viewerId: string): Promise<number | null> => Promise.resolve(1),
);
const recordDwell = vi.fn((_postId: string, _durationMs: number) => Promise.resolve());
const recordInteraction = vi.fn(
  (_userId: string, _postId: string, _signal: string, _opts: unknown) => Promise.resolve(),
);

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

import { closePostgres, connectPostgres } from '../db/postgres';
import { clearPostScope, postScope, seedPost } from './helpers/postFixtures';
import { applyImpressionSignals } from '../mtn/feed/FeedInteractionTracker';

const scope = postScope('impression-signals');
const AUTHOR = scope.user('author');
const VIEWER = scope.user('viewer');

function impression(postUri: string, overrides: Record<string, unknown> = {}) {
  return {
    userId: VIEWER,
    feedDescriptor: 'for_you',
    postUri,
    event: 'impression' as const,
    timestamp: new Date(),
    ...overrides,
  };
}

describe('applyImpressionSignals', () => {
  beforeAll(async () => {
    await connectPostgres();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    recordDedupedView.mockResolvedValue(1);
  });

  afterEach(async () => {
    await clearPostScope(scope);
  });

  afterAll(async () => {
    await closePostgres();
  });

  describe('dwell clamping', () => {
    it('clamps an absurd client durationMs to MtnConfig.preferences.maxDwellMs', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });

      await applyImpressionSignals(impression(post.id, { durationMs: 999_999_999 }));

      expect(recordDwell).toHaveBeenCalledTimes(1);
      expect(recordDwell).toHaveBeenCalledWith(post.id, MtnConfig.preferences.maxDwellMs);
    });

    it('passes a sane durationMs through unchanged', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });

      await applyImpressionSignals(impression(post.id, { durationMs: 4000 }));

      expect(recordDwell).toHaveBeenCalledWith(post.id, 4000);
    });
  });

  describe('dedupe (record dwell once per post/viewer)', () => {
    it('does NOT record dwell when the view was already counted', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });
      recordDedupedView.mockResolvedValue(null);

      await applyImpressionSignals(impression(post.id, { durationMs: 4000 }));

      expect(recordDedupedView).toHaveBeenCalledTimes(1);
      expect(recordDwell).not.toHaveBeenCalled();
    });

    it('records dwell only on the first (newly-counted) view', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });

      await applyImpressionSignals(impression(post.id, { durationMs: 4000 }));

      expect(recordDwell).toHaveBeenCalledTimes(1);
    });
  });

  describe('self-authored guard', () => {
    it('records no dwell, no view, and no preference learning for the viewer own post', async () => {
      const own = await seedPost(scope, { oxyUserId: VIEWER });

      await applyImpressionSignals(impression(own.id, { durationMs: 4000 }));

      expect(recordDedupedView).not.toHaveBeenCalled();
      expect(recordDwell).not.toHaveBeenCalled();
      expect(recordInteraction).not.toHaveBeenCalled();
    });

    it('still learns from another author post', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });

      await applyImpressionSignals(impression(post.id, { durationMs: 4000 }));

      expect(recordInteraction).toHaveBeenCalledTimes(1);
    });
  });

  describe('eligibility', () => {
    it('is a no-op for a postUri that is not a local post id', async () => {
      // A federated URI, or anything else a client invents, simply matches no
      // row. The id-shape pre-check this replaced would ALSO have discarded
      // every post created since the uuid cutover.
      await applyImpressionSignals(impression('https://remote.example/notlocal'));

      expect(recordDedupedView).not.toHaveBeenCalled();
      expect(recordDwell).not.toHaveBeenCalled();
    });

    it('is a no-op for a post id that does not exist', async () => {
      await applyImpressionSignals(
        impression('019fffff-ffff-7fff-bfff-ffffffffffff', { durationMs: 4000 }),
      );

      expect(recordDedupedView).not.toHaveBeenCalled();
      expect(recordDwell).not.toHaveBeenCalled();
    });

    it('is a no-op for a NON-PUBLIC post the viewer sent telemetry about', async () => {
      const post = await seedPost(scope, {
        oxyUserId: AUTHOR,
        visibility: PostVisibility.PRIVATE,
      });

      await applyImpressionSignals(impression(post.id, { durationMs: 4000 }));

      expect(recordDedupedView).not.toHaveBeenCalled();
      expect(recordDwell).not.toHaveBeenCalled();
      expect(recordInteraction).not.toHaveBeenCalled();
    });

    it('is a no-op for an UNPUBLISHED post the viewer sent telemetry about', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR, status: 'draft' });

      await applyImpressionSignals(impression(post.id, { durationMs: 4000 }));

      expect(recordDedupedView).not.toHaveBeenCalled();
      expect(recordDwell).not.toHaveBeenCalled();
      expect(recordInteraction).not.toHaveBeenCalled();
    });
  });

  /**
   * The view count travels back to the reporting client, which is the only way a
   * screen showing a post can learn about the view IT just caused. Each `null`
   * arm below is a DIFFERENT reason not to report one, and they are enumerated
   * rather than sampled because a single leaked number is a "+1" the server
   * never performed.
   */
  describe('the counted total travels back', () => {
    it('returns the post new total when the view counted', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });
      recordDedupedView.mockResolvedValue(42);

      await expect(applyImpressionSignals(impression(post.id, { durationMs: 4000 })))
        .resolves.toBe(42);
    });

    it('returns null for a repeat impression inside the dedupe window', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });
      recordDedupedView.mockResolvedValue(null);

      await expect(applyImpressionSignals(impression(post.id, { durationMs: 4000 })))
        .resolves.toBeNull();
    });

    it('returns null for the viewer own post, whatever the counter would have said', async () => {
      const own = await seedPost(scope, { oxyUserId: VIEWER });
      // Would be reported if the self-view guard did not short-circuit first.
      recordDedupedView.mockResolvedValue(42);

      await expect(applyImpressionSignals(impression(own.id, { durationMs: 4000 })))
        .resolves.toBeNull();
    });

    it('returns null for an ineligible post', async () => {
      const draft = await seedPost(scope, { oxyUserId: AUTHOR, status: 'draft' });
      recordDedupedView.mockResolvedValue(42);

      await expect(applyImpressionSignals(impression(draft.id, { durationMs: 4000 })))
        .resolves.toBeNull();
    });

    it('returns null for a non-local postUri', async () => {
      recordDedupedView.mockResolvedValue(42);

      await expect(applyImpressionSignals(impression('https://remote.example/notlocal')))
        .resolves.toBeNull();
    });
  });
});
