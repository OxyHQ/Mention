import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `laneId` through `PostCreationService.create`, asserted on the STORED ROW.
 *
 * The insert is an explicit typed literal, not a spread of the params, so a
 * field that is not listed there vanishes with a 201 and no error anywhere —
 * which is exactly what happened when the columns first landed: `PostRecordInput`
 * had no `laneId`, every write dropped it, and nothing said so. A row assertion
 * is what catches that; "the object handed to the constructor carried the key"
 * is a claim about the test's own fixture.
 *
 * Validation lives in the SERVICE rather than the controller so no future caller
 * can route around it; the cases below prove it runs before anything is written.
 */

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearPostScope,
  postScope,
  readPostRow,
  seedLane,
  track,
} from '../helpers/postFixtures';

vi.mock('../../services/PostRecentReplierService', () => ({
  recordRecentReplierForPost: vi.fn(async () => undefined),
}));
vi.mock('../../services/postEnrichment', () => ({ enrichIngestedPosts: vi.fn() }));
vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn(async () => undefined),
  emitRepostCreated: vi.fn(async () => undefined),
}));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));
vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: vi.fn(() => ({})) }));
vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));
vi.mock('../../services/MediaMetadataService', () => ({
  mediaMetadataService: { enrichFromOxy: vi.fn(async (media: unknown[]) => media) },
  readPersistedMediaFields: vi.fn(() => ({})),
}));

import { postCreationService } from '../../services/PostCreationService';
import { LaneAssignmentError } from '../../utils/laneAssignment';

const scope = postScope('post-creation-lane');
const USER_ID = scope.user('author');

/** Create through the real service, tracking the row for teardown. */
async function create(params: Record<string, unknown>): Promise<string> {
  const post = await postCreationService.create({
    oxyUserId: USER_ID,
    content: { text: 'a post' },
    skipNotifications: true,
    ...params,
  } as Parameters<typeof postCreationService.create>[0]);
  track(scope, post.id);
  return post.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('PostCreationService.create — laneId', () => {
  it('writes the lane onto the post when one is supplied', async () => {
    const laneId = await seedLane(scope, { ownerId: USER_ID });
    const id = await create({ content: { text: 'in a lane' }, laneId });

    expect((await readPostRow(id))?.laneId).toBe(laneId);
  });

  it('stores NULL when there is no lane, which the partial index excludes', async () => {
    const id = await create({ content: { text: 'no lane' } });

    // Mongo had to leave the field ABSENT: `post_lane_chrono_v1` was partial on
    // `{ laneId: { $exists: true } }`, which a stored `null` SATISFIED, so a null
    // would have indexed the whole collection. The Postgres filter is `lane_id is
    // not null`, so null is the state that stays out of it — absent and null are
    // one state here rather than two that can disagree.
    expect((await readPostRow(id))?.laneId).toBeNull();
  });

  it('stores NULL for an explicit null too', async () => {
    const id = await create({ content: { text: 'explicit null' }, laneId: null });

    expect((await readPostRow(id))?.laneId).toBeNull();
  });

  it('refuses a lane the author does not own, BEFORE writing anything', async () => {
    const foreign = await seedLane(scope, { ownerId: scope.user('somebody-else') });

    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'stolen lane' },
        laneId: foreign,
        skipNotifications: true,
      }),
    ).rejects.toBeInstanceOf(LaneAssignmentError);
  });

  it('refuses a lane on a reply and on a boost', async () => {
    const laneId = await seedLane(scope, { ownerId: USER_ID });
    const parentId = await create({ content: { text: 'a parent' } });

    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'a reply' },
        parentPostId: parentId,
        laneId,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: '' },
        boostOf: parentId,
        laneId,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a CHANNEL-owned lane on a post with no channel', async () => {
    // The ownership lookup is scoped by publisher, and the publisher of a post
    // with no channel is its author — so a channel's lane is invisible to it and
    // answers the same 404 somebody else's would.
    const channelLane = await seedLane(scope, {
      ownerType: 'channel',
      ownerId: 'post-creation-lane-channel',
    });

    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'wrong publisher' },
        laneId: channelLane,
        skipNotifications: true,
      }),
    ).rejects.toBeInstanceOf(LaneAssignmentError);
  });
});
