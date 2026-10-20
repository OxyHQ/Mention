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
const recordInteractions = vi.fn((_userId: string, _entries: unknown[]) => Promise.resolve());

vi.mock('../services/feedViewCounter', () => ({
  recordDedupedView: (postId: string, viewerId: string) => recordDedupedView(postId, viewerId),
  isPostEligibleForViewTelemetry: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../services/dwellAggregate', () => ({
  recordDwell: (postId: string, durationMs: number) => recordDwell(postId, durationMs),
}));

vi.mock('../services/UserPreferenceService', () => ({
  userPreferenceService: {
    recordInteractions: (userId: string, entries: unknown[]) => recordInteractions(userId, entries),
  },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { feedInteractions } from '../db/schema/feeds';
import { clearPostScope, postScope, seedPost } from './helpers/postFixtures';
import {
  applyImpressionSignals,
  type FeedInteractionData,
  trackFeedInteractions,
} from '../mtn/feed/FeedInteractionTracker';

/** One impression through the batch API; its view count. */
async function applyOne(interaction: FeedInteractionData): Promise<number | null> {
  const [count] = await applyImpressionSignals([interaction]);
  return count ?? null;
}

/** One interaction through the batch API; its view count. */
async function trackOne(interaction: FeedInteractionData): Promise<number | null> {
  const [count] = await trackFeedInteractions([interaction]);
  return count ?? null;
}

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

      await applyOne(impression(post.id, { durationMs: 999_999_999 }));

      expect(recordDwell).toHaveBeenCalledTimes(1);
      expect(recordDwell).toHaveBeenCalledWith(post.id, MtnConfig.preferences.maxDwellMs);
    });

    it('passes a sane durationMs through unchanged', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });

      await applyOne(impression(post.id, { durationMs: 4000 }));

      expect(recordDwell).toHaveBeenCalledWith(post.id, 4000);
    });
  });

  describe('dedupe (record dwell once per post/viewer)', () => {
    it('does NOT record dwell when the view was already counted', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });
      recordDedupedView.mockResolvedValue(null);

      await applyOne(impression(post.id, { durationMs: 4000 }));

      expect(recordDedupedView).toHaveBeenCalledTimes(1);
      expect(recordDwell).not.toHaveBeenCalled();
    });

    it('records dwell only on the first (newly-counted) view', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });

      await applyOne(impression(post.id, { durationMs: 4000 }));

      expect(recordDwell).toHaveBeenCalledTimes(1);
    });
  });

  describe('self-authored guard', () => {
    it('records no dwell, no view, and no preference learning for the viewer own post', async () => {
      const own = await seedPost(scope, { oxyUserId: VIEWER });

      await applyOne(impression(own.id, { durationMs: 4000 }));

      expect(recordDedupedView).not.toHaveBeenCalled();
      expect(recordDwell).not.toHaveBeenCalled();
      expect(recordInteractions).not.toHaveBeenCalled();
    });

    it('still learns from another author post', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });

      await applyOne(impression(post.id, { durationMs: 4000 }));

      expect(recordInteractions).toHaveBeenCalledTimes(1);
    });
  });

  describe('a batch', () => {
    it("applies the viewer's signals in ONE preference write, in the order observed", async () => {
      const first = await seedPost(scope, { oxyUserId: AUTHOR });
      const second = await seedPost(scope, { oxyUserId: AUTHOR });

      const counts = await applyImpressionSignals([
        impression(first.id, { durationMs: 4000 }),
        impression(second.id, { durationMs: 300 }),
      ]);

      expect(counts).toEqual([1, 1]);
      expect(recordInteractions).toHaveBeenCalledTimes(1);
      expect(recordInteractions).toHaveBeenCalledWith(VIEWER, [
        { postId: first.id, type: 'view', context: { surface: 'for_you' } },
        { postId: second.id, type: 'skip', context: { surface: 'for_you' } },
      ]);
    });
  });

  describe('eligibility', () => {
    it('is a no-op for a postUri that is not a local post id', async () => {
      // A federated URI, or anything else a client invents, simply matches no
      // row. The id-shape pre-check this replaced would ALSO have discarded
      // every post created since the uuid cutover.
      await applyOne(impression('https://remote.example/notlocal'));

      expect(recordDedupedView).not.toHaveBeenCalled();
      expect(recordDwell).not.toHaveBeenCalled();
    });

    it('is a no-op for a post id that does not exist', async () => {
      await applyOne(impression('019fffff-ffff-7fff-bfff-ffffffffffff', { durationMs: 4000 }));

      expect(recordDedupedView).not.toHaveBeenCalled();
      expect(recordDwell).not.toHaveBeenCalled();
    });

    it('is a no-op for a NON-PUBLIC post the viewer sent telemetry about', async () => {
      const post = await seedPost(scope, {
        oxyUserId: AUTHOR,
        visibility: PostVisibility.PRIVATE,
      });

      await applyOne(impression(post.id, { durationMs: 4000 }));

      expect(recordDedupedView).not.toHaveBeenCalled();
      expect(recordDwell).not.toHaveBeenCalled();
      expect(recordInteractions).not.toHaveBeenCalled();
    });

    it('is a no-op for an UNPUBLISHED post the viewer sent telemetry about', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR, status: 'draft' });

      await applyOne(impression(post.id, { durationMs: 4000 }));

      expect(recordDedupedView).not.toHaveBeenCalled();
      expect(recordDwell).not.toHaveBeenCalled();
      expect(recordInteractions).not.toHaveBeenCalled();
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

      await expect(applyOne(impression(post.id, { durationMs: 4000 }))).resolves.toBe(42);
    });

    it('returns null for a repeat impression inside the dedupe window', async () => {
      const post = await seedPost(scope, { oxyUserId: AUTHOR });
      recordDedupedView.mockResolvedValue(null);

      await expect(applyOne(impression(post.id, { durationMs: 4000 }))).resolves.toBeNull();
    });

    it('returns null for the viewer own post, whatever the counter would have said', async () => {
      const own = await seedPost(scope, { oxyUserId: VIEWER });
      // Would be reported if the self-view guard did not short-circuit first.
      recordDedupedView.mockResolvedValue(42);

      await expect(applyOne(impression(own.id, { durationMs: 4000 }))).resolves.toBeNull();
    });

    it('returns null for an ineligible post', async () => {
      const draft = await seedPost(scope, { oxyUserId: AUTHOR, status: 'draft' });
      recordDedupedView.mockResolvedValue(42);

      await expect(applyOne(impression(draft.id, { durationMs: 4000 }))).resolves.toBeNull();
    });

    it('returns null for a non-local postUri', async () => {
      recordDedupedView.mockResolvedValue(42);

      await expect(applyOne(impression('https://remote.example/notlocal'))).resolves.toBeNull();
    });
  });
});

/**
 * The raw analytics row — the write that was still going to the legacy store.
 *
 * `applyImpressionSignals` above covers the DERIVED signals, which were already
 * Postgres. Nothing covered the raw row at all, which is how it stayed on a
 * dynamic `import('../../models/FeedInteraction')` after every other write in
 * this file's subject had moved: the Postgres table exists, is indexed, is
 * swept and is backfilled, so the divergence produced no error anywhere — it
 * would simply have frozen `feed_interactions` at the backfill snapshot while
 * new rows accumulated in a collection nothing reads.
 *
 * Scoped by `userId`, so the cleanup names this file's own rows rather than
 * emptying a table every other suite shares.
 */
describe('trackFeedInteractions — the raw analytics row', () => {
  const RAW_VIEWER = scope.user('raw-viewer');

  beforeAll(async () => {
    await connectPostgres();
  });

  afterEach(async () => {
    await getDb().delete(feedInteractions).where(eq(feedInteractions.userId, RAW_VIEWER));
    await clearPostScope(scope);
  });

  afterAll(async () => {
    await closePostgres();
  });

  const rowsForViewer = () =>
    getDb().select().from(feedInteractions).where(eq(feedInteractions.userId, RAW_VIEWER));

  it("writes the row to Postgres, carrying the CALLER's timestamp", async () => {
    // The timestamp is the load-bearing field. `created_at` has a `now()`
    // default, so an insert that omitted it would look correct in every other
    // respect and silently re-date every interaction to insert time — which is
    // the column the retention sweep and the online report both range-scan.
    const happenedAt = new Date('2026-07-04T05:06:07.000Z');
    const post = await seedPost(scope, { oxyUserId: AUTHOR });

    await trackOne({
      userId: RAW_VIEWER,
      feedDescriptor: 'for_you',
      postUri: post.id,
      event: 'click',
      durationMs: 1234,
      timestamp: happenedAt,
    });

    const rows = await rowsForViewer();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: RAW_VIEWER,
      feedDescriptor: 'for_you',
      postUri: post.id,
      event: 'click',
      durationMs: 1234,
    });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(rows[0]?.createdAt.toISOString()).toBe(happenedAt.toISOString());
  });

  it('writes the row on the impression path too, not only the plain events', async () => {
    // `impression` is the one event with derived side effects, and it returns
    // early through `applyImpressionSignals`. A raw write placed after that
    // branch would record every event EXCEPT the most common one.
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    recordDedupedView.mockResolvedValue(7);

    await trackOne({
      userId: RAW_VIEWER,
      feedDescriptor: 'for_you',
      postUri: post.id,
      event: 'impression',
      durationMs: 4000,
      timestamp: new Date(),
    });

    const rows = await rowsForViewer();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe('impression');
  });

  it('records an interaction whose postUri names no post — analytics carry no foreign key', async () => {
    // The healthy case above has a real post; this is the same write with the
    // one thing the schema deliberately does NOT constrain. `post_uri` is
    // client-supplied and carries no foreign key on purpose, so a forged or
    // already-deleted id must still record rather than raise — a feed request
    // must never fail because its analytics did.
    await expect(
      trackOne({
        userId: RAW_VIEWER,
        feedDescriptor: 'for_you',
        postUri: 'no-such-post-id',
        event: 'click',
        timestamp: new Date(),
      }),
    ).resolves.toBeNull();

    const rows = await rowsForViewer();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.postUri).toBe('no-such-post-id');
    // Omitted by the caller, so it must be NULL rather than 0 — a zero would be
    // a dwell measurement nobody took.
    expect(rows[0]?.durationMs).toBeNull();
  });
});
