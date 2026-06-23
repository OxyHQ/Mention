import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { FeedQueryBuilder } from '../utils/feedQueryBuilder';
import { ChronoCursor } from '../mtn/feed/CursorBuilder';

/**
 * Regression test for the intermittent "boost disappears from profile feed" bug.
 *
 * The profile feed (`getUserProfileFeed`) sorts by `createdAt: -1`, but the
 * query builder USED to paginate with a bare `_id < cursor` filter. For
 * federated boosts/notes — imported with `createdAt = <remote published>` while
 * `_id` is generated at import time — a post with an OLD `createdAt` can carry a
 * LARGE `_id`. Against a `createdAt`-sorted page, a bare `_id < cursor` filter
 * permanently skips those posts at the page boundary → the boost "disappears".
 *
 * The fix makes pagination a chronological keyset (`ChronoCursor`) matching the
 * `createdAt: -1` sort. These assertions FAIL on the old code (bare `_id < cursor`
 * ignoring `createdAt`) and PASS after the fix.
 */
describe('FeedQueryBuilder.buildUserProfileQuery — chronological cursor', () => {
  const userId = 'oxy-user-123';

  it('builds the posts query with no cursor clause when no cursor is given', () => {
    const query = FeedQueryBuilder.buildUserProfileQuery(userId, 'posts');

    expect(query.oxyUserId).toBe(userId);
    expect(query.visibility).toBeTruthy();
    expect(query.parentPostId).toBeNull();

    // No pagination clause when there is no cursor.
    expect(query._id).toBeUndefined();
    expect(query.$or).toBeUndefined();
  });

  it('applies a compound createdAt/_id keyset (NOT a bare _id filter) for a chronological cursor', () => {
    const anchorId = new mongoose.Types.ObjectId();
    const anchorCreatedAt = new Date('2024-01-01T00:00:00.000Z');
    const cursor = ChronoCursor.build(anchorId.toString(), anchorCreatedAt);

    const query = FeedQueryBuilder.buildUserProfileQuery(userId, 'posts', cursor);

    // The fix: the cursor must apply a compound chronological keyset matching
    // the `createdAt: -1` sort — NOT a bare `_id: { $lt }` that ignores createdAt.
    expect(query._id).toBeUndefined();

    const orClauses = query.$or as Array<Record<string, unknown>>;
    expect(Array.isArray(orClauses)).toBe(true);
    expect(orClauses).toHaveLength(2);

    // Branch 1: strictly-older createdAt.
    expect(orClauses[0]).toEqual({ createdAt: { $lt: anchorCreatedAt } });

    // Branch 2: same createdAt, smaller _id (tie-breaker).
    const tieBreak = orClauses[1] as { createdAt: Date; _id: { $lt: mongoose.Types.ObjectId } };
    expect(tieBreak.createdAt).toEqual(anchorCreatedAt);
    expect(tieBreak._id.$lt).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(tieBreak._id.$lt.toString()).toBe(anchorId.toString());
  });

  it('falls back to a bare _id filter for a legacy bare-ObjectId cursor (backward compatible)', () => {
    const legacyCursor = new mongoose.Types.ObjectId().toString();

    // Must not throw for in-flight clients still sending a bare ObjectId cursor.
    const query = FeedQueryBuilder.buildUserProfileQuery(userId, 'posts', legacyCursor);

    expect(query.$or).toBeUndefined();
    const idFilter = query._id as { $lt: mongoose.Types.ObjectId };
    expect(idFilter.$lt).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(idFilter.$lt.toString()).toBe(legacyCursor);
  });

  it('boosts type applies boostOf filter AND the chronological keyset cursor', () => {
    const anchorId = new mongoose.Types.ObjectId();
    const anchorCreatedAt = new Date('2023-06-15T12:30:00.000Z');
    const cursor = ChronoCursor.build(anchorId.toString(), anchorCreatedAt);

    const query = FeedQueryBuilder.buildUserProfileQuery(userId, 'boosts', cursor);

    // Dedicated boosts tab still filters to boosts only.
    expect(query.boostOf).toEqual({ $ne: null });

    // And it paginates chronologically — so federated boosts with an old
    // createdAt but a large _id are no longer skipped at the page boundary.
    expect(query._id).toBeUndefined();
    const orClauses = query.$or as Array<Record<string, unknown>>;
    expect(Array.isArray(orClauses)).toBe(true);
    expect(orClauses).toHaveLength(2);
    expect(orClauses[0]).toEqual({ createdAt: { $lt: anchorCreatedAt } });
  });

  it('replies type applies the chronological keyset cursor', () => {
    const anchorId = new mongoose.Types.ObjectId();
    const anchorCreatedAt = new Date('2022-12-31T23:59:59.000Z');
    const cursor = ChronoCursor.build(anchorId.toString(), anchorCreatedAt);

    const query = FeedQueryBuilder.buildUserProfileQuery(userId, 'replies', cursor);

    expect(query.parentPostId).toEqual({ $ne: null });
    expect(query._id).toBeUndefined();
    expect(Array.isArray(query.$or)).toBe(true);
  });
});
