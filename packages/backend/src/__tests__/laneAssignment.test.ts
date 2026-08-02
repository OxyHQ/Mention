import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * The one rule that governs putting a post in a lane.
 *
 * Every assertion here is about a REFUSAL rather than a drop: an author who is
 * told nothing goes on believing they published in a lane, which is the whole
 * reason this validator exists instead of a `postData` filter.
 */

const laneExists = vi.fn(async (): Promise<{ _id: string } | null> => null);
vi.mock('../models/Lane', () => ({ Lane: { exists: (...args: unknown[]) => laneExists(...args) } }));

import { assertLaneAssignable, LaneAssignmentError } from '../utils/laneAssignment';

const LANE_ID = new mongoose.Types.ObjectId().toString();

beforeEach(() => {
  laneExists.mockReset().mockResolvedValue({ _id: LANE_ID });
});

describe('assertLaneAssignable — no lane requested', () => {
  it.each([undefined, null, ''])('resolves without a query for %p', async (laneId) => {
    await expect(assertLaneAssignable({ laneId, authorId: 'u1' })).resolves.toBeUndefined();
    // The common case by far: it must cost nothing.
    expect(laneExists).not.toHaveBeenCalled();
  });

  it('does not refuse a lane-less reply or boost', async () => {
    await expect(
      assertLaneAssignable({ authorId: 'u1', parentPostId: 'p1' }),
    ).resolves.toBeUndefined();
    await expect(assertLaneAssignable({ authorId: 'u1', boostOf: 'p1' })).resolves.toBeUndefined();
  });
});

describe('assertLaneAssignable — replies and boosts', () => {
  it('refuses a lane on a reply with 400', async () => {
    await expect(
      assertLaneAssignable({ laneId: LANE_ID, authorId: 'u1', parentPostId: 'p1' }),
    ).rejects.toMatchObject({ status: 400, message: 'A reply cannot be assigned to a lane' });
    // Refused before the lookup: the shape of the post decides this, not the DB.
    expect(laneExists).not.toHaveBeenCalled();
  });

  it('refuses a lane on a boost with 400', async () => {
    await expect(
      assertLaneAssignable({ laneId: LANE_ID, authorId: 'u1', boostOf: 'p1' }),
    ).rejects.toMatchObject({ status: 400, message: 'A boost cannot be assigned to a lane' });
    expect(laneExists).not.toHaveBeenCalled();
  });

  it('allows a lane on a QUOTE — an original post with its own body', async () => {
    // A quote carries neither `parentPostId` nor `boostOf`, so it is simply a
    // top-level post here: the validator has no quote-shaped input at all, which
    // is the design (only the two refused shapes are named).
    await expect(assertLaneAssignable({ laneId: LANE_ID, authorId: 'u1' })).resolves.toBeUndefined();
  });
});

describe('assertLaneAssignable — ownership', () => {
  it('scopes the lookup to the AUTHOR when the post has no channel', async () => {
    await assertLaneAssignable({ laneId: LANE_ID, authorId: 'u1' });
    expect(laneExists).toHaveBeenCalledWith({ _id: LANE_ID, ownerType: 'user', ownerId: 'u1' });
  });

  it('scopes the lookup to the CHANNEL when the post has one', async () => {
    await assertLaneAssignable({ laneId: LANE_ID, authorId: 'u1', channelId: 'c1' });
    // The publisher is the channel, so a lane of the AUTHOR'S is not eligible —
    // this is what stops a post mixing a user's lane with a channel destination.
    expect(laneExists).toHaveBeenCalledWith({ _id: LANE_ID, ownerType: 'channel', ownerId: 'c1' });
  });

  it('answers 404 for a lane belonging to somebody else', async () => {
    // Scoped lookup ⇒ a foreign lane is indistinguishable from a missing one.
    // Neither answer is an oracle for whether a given lane id is real.
    laneExists.mockResolvedValue(null);
    await expect(
      assertLaneAssignable({ laneId: LANE_ID, authorId: 'u1' }),
    ).rejects.toMatchObject({ status: 404, message: 'Lane not found' });
  });

  it('answers the SAME 404 for a malformed id, without reaching Mongo', async () => {
    await expect(
      assertLaneAssignable({ laneId: 'not-an-object-id', authorId: 'u1' }),
    ).rejects.toMatchObject({ status: 404, message: 'Lane not found' });
    expect(laneExists).not.toHaveBeenCalled();
  });

  it('refuses a lane on a post with no publisher at all', async () => {
    await expect(
      assertLaneAssignable({ laneId: LANE_ID, authorId: null }),
    ).rejects.toMatchObject({ status: 400 });
    expect(laneExists).not.toHaveBeenCalled();
  });

  it('throws a LaneAssignmentError, which the HTTP layer maps by status', async () => {
    laneExists.mockResolvedValue(null);
    const error = await assertLaneAssignable({ laneId: LANE_ID, authorId: 'u1' }).catch((e) => e);
    expect(error).toBeInstanceOf(LaneAssignmentError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LaneAssignmentError');
  });
});
