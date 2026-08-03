import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * The one rule that governs putting a post in a lane.
 *
 * Every assertion here is about a REFUSAL rather than a drop: an author who is
 * told nothing goes on believing they published in a lane, which is the whole
 * reason this validator exists instead of a `postData` filter.
 *
 * ## Real lanes, because the failure this guards against was invisible to a mock
 *
 * The validator used to short-circuit on `ObjectId.isValid(laneId)`. After the
 * cutover `lanes.id` is uuid v7, so that answered `false` for EVERY real lane and
 * every assignment 404'd — nothing could be laned at all. A mocked `Lane.exists`
 * cannot see it: the mock reports whether it was CALLED, and the case that
 * asserted "without reaching Mongo" for a malformed id would have gone on passing
 * while the same branch silently rejected every legitimate one. So the lanes here
 * are rows, with the ids the database mints.
 */

import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { lanes } from '../db/schema/channels';
import { assertLaneAssignable, LaneAssignmentError } from '../utils/laneAssignment';

const AUTHOR = 'laneassign-author';
/**
 * A CHANNEL account. Nothing distinguishes it from {@link AUTHOR} but the id:
 * a channel is an Oxy account, so it publishes into its own lanes through the
 * same single `ownerId` comparison everybody else does.
 */
const CHANNEL = 'laneassign-channel';
const seeded: string[] = [];
let seq = 0;

/** One lane, cleaned with the rest. Returns its id. */
async function lane(ownerId: string = AUTHOR): Promise<string> {
  const name = `laneassign-${seq++}`;
  const [row] = await getDb()
    .insert(lanes)
    .values({ ownerId, name, nameLower: name })
    .returning({ id: lanes.id });
  seeded.push(row.id);
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  const ids = seeded.splice(0);
  if (ids.length > 0) await getDb().delete(lanes).where(inArray(lanes.id, ids));
});

afterAll(async () => {
  await closePostgres();
});

describe('assertLaneAssignable — no lane requested', () => {
  it.each([undefined, null, ''])('resolves for %p', async (laneId) => {
    await expect(assertLaneAssignable({ laneId, authorId: AUTHOR })).resolves.toBeUndefined();
  });

  it('does not refuse a lane-less reply or boost', async () => {
    await expect(
      assertLaneAssignable({ authorId: AUTHOR, parentPostId: 'p1' }),
    ).resolves.toBeUndefined();
    await expect(
      assertLaneAssignable({ authorId: AUTHOR, boostOf: 'p1' }),
    ).resolves.toBeUndefined();
  });
});

describe('assertLaneAssignable — replies and boosts', () => {
  it('refuses a lane on a reply with 400', async () => {
    // The lane is real and eligible, so the 400 can only come from the SHAPE of
    // the post — which is the property under test.
    const laneId = await lane();
    await expect(
      assertLaneAssignable({ laneId, authorId: AUTHOR, parentPostId: 'p1' }),
    ).rejects.toMatchObject({ status: 400, message: 'A reply cannot be assigned to a lane' });
  });

  it('refuses a lane on a boost with 400', async () => {
    const laneId = await lane();
    await expect(
      assertLaneAssignable({ laneId, authorId: AUTHOR, boostOf: 'p1' }),
    ).rejects.toMatchObject({ status: 400, message: 'A boost cannot be assigned to a lane' });
  });

  it('allows a lane on a QUOTE — an original post with its own body', async () => {
    // A quote carries neither `parentPostId` nor `boostOf`, so it is simply a
    // top-level post here: the validator has no quote-shaped input at all, which
    // is the design (only the two refused shapes are named).
    const laneId = await lane();
    await expect(assertLaneAssignable({ laneId, authorId: AUTHOR })).resolves.toBeUndefined();
  });
});

describe('assertLaneAssignable — ownership', () => {
  it('scopes the lookup to the post\'s OWNER', async () => {
    const laneId = await lane();
    await expect(assertLaneAssignable({ laneId, authorId: AUTHOR })).resolves.toBeUndefined();
  });

  it('scopes it to the CHANNEL when the channel is the post\'s owner', async () => {
    // A channel is an Oxy account and authors its own posts, so the caller passes
    // the channel as `authorId` and the same single comparison applies — a lane of
    // the WRITER'S is not eligible, which is what stops a channel post being filed
    // under a personal lane tab. Stated in BOTH directions, because one direction
    // alone passes just as well against a lookup that matches everything.
    const channelLane = await lane(CHANNEL);
    const authorLane = await lane();

    await expect(
      assertLaneAssignable({ laneId: channelLane, authorId: CHANNEL }),
    ).resolves.toBeUndefined();
    // The pairing that deanonymizes a channel writer if it gets through: the
    // DTO stays anonymous, but a lane tab is scoped to one author.
    await expect(
      assertLaneAssignable({ laneId: authorLane, authorId: CHANNEL }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      assertLaneAssignable({ laneId: channelLane, authorId: AUTHOR }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('answers 404 for a lane belonging to somebody else', async () => {
    // Scoped lookup ⇒ a foreign lane is indistinguishable from a missing one.
    // Neither answer is an oracle for whether a given lane id is real.
    const laneId = await lane('laneassign-somebody-else');
    await expect(assertLaneAssignable({ laneId, authorId: AUTHOR })).rejects.toMatchObject({
      status: 404,
      message: 'Lane not found',
    });
    // The foreign lane really exists — otherwise this passes against a seeding
    // failure just as well as against the scoping it is meant to prove.
    const [row] = await getDb().select({ id: lanes.id }).from(lanes).where(eq(lanes.id, laneId));
    expect(row).toBeDefined();
  });

  it('answers the SAME 404 for an id that names no lane', async () => {
    await expect(
      assertLaneAssignable({ laneId: 'laneassign-no-such-lane', authorId: AUTHOR }),
    ).rejects.toMatchObject({ status: 404, message: 'Lane not found' });
  });

  it('accepts a real uuid v7 lane id — the shape the removed guard rejected', async () => {
    const laneId = await lane();
    expect(laneId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    await expect(assertLaneAssignable({ laneId, authorId: AUTHOR })).resolves.toBeUndefined();
  });

  it('refuses a lane on a post with no publisher at all', async () => {
    const laneId = await lane();
    await expect(assertLaneAssignable({ laneId, authorId: null })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('throws a LaneAssignmentError, which the HTTP layer maps by status', async () => {
    const error = await assertLaneAssignable({
      laneId: 'laneassign-no-such-lane',
      authorId: AUTHOR,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(LaneAssignmentError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LaneAssignmentError');
  });
});
