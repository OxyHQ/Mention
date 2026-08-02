import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * `laneId` through `PostCreationService.create`.
 *
 * `postData` is an explicit WHITELIST, not a spread of the params, so a field
 * that is not listed there vanishes with a 201 and no error anywhere. And the
 * field must be written ONLY when there is a lane: `post_lane_chrono_v1` is
 * partial on `{ laneId: { $exists: true } }`, which a stored `null` satisfies —
 * so writing one would index the whole collection and defeat the partial index.
 *
 * Validation lives in the SERVICE rather than the controller so no future caller
 * can route around it; the test below proves it runs before anything is written.
 */

const saved: Array<Record<string, unknown>> = [];
const constructedWith: Array<Record<string, unknown>> = [];

vi.mock('../../models/Post', () => {
  class FakePost {
    [key: string]: unknown;

    constructor(data: Record<string, unknown>) {
      constructedWith.push(data);
      Object.assign(this, data);
      this._id = new mongoose.Types.ObjectId();
    }

    async save(): Promise<void> {
      saved.push(this as unknown as Record<string, unknown>);
    }

    toObject(): Record<string, unknown> {
      return { ...(this as unknown as Record<string, unknown>) };
    }
  }
  return {
    Post: Object.assign(FakePost, {
      find: vi.fn(() => ({ select: () => ({ lean: async () => [] }) })),
      findById: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
    }),
    POST_CLASSIFICATION_PENDING: 'pending',
  };
});

const laneExists = vi.fn();
vi.mock('../../models/Lane', () => ({
  Lane: { exists: (...args: unknown[]) => laneExists(...args) },
}));

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

const USER_ID = 'author-1';
const LANE_ID = new mongoose.Types.ObjectId().toString();

beforeEach(() => {
  saved.length = 0;
  constructedWith.length = 0;
  laneExists.mockReset().mockResolvedValue({ _id: LANE_ID });
});

describe('PostCreationService.create — laneId', () => {
  it('writes the lane onto the post when one is supplied', async () => {
    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'in a lane' },
      laneId: LANE_ID,
      skipNotifications: true,
    });

    expect(constructedWith).toHaveLength(1);
    expect(constructedWith[0].laneId).toBe(LANE_ID);
    expect(saved).toHaveLength(1);
  });

  it('omits the KEY entirely when there is no lane — never a stored null', async () => {
    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'no lane' },
      skipNotifications: true,
    });

    // `{ laneId: null }` would satisfy the partial index's `$exists` filter and
    // index every post in the collection.
    expect('laneId' in constructedWith[0]).toBe(false);
  });

  it('omits the key for an explicit null too', async () => {
    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'explicit null' },
      laneId: null,
      skipNotifications: true,
    });

    expect('laneId' in constructedWith[0]).toBe(false);
    // No lane requested ⇒ no lookup at all.
    expect(laneExists).not.toHaveBeenCalled();
  });

  it('refuses a lane the author does not own, BEFORE writing anything', async () => {
    laneExists.mockResolvedValue(null);

    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'stolen lane' },
        laneId: LANE_ID,
        skipNotifications: true,
      }),
    ).rejects.toBeInstanceOf(LaneAssignmentError);

    // Enforced in the SERVICE, so no caller can route around it — and nothing
    // was constructed or saved.
    expect(constructedWith).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('refuses a lane on a reply and on a boost', async () => {
    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'a reply' },
        parentPostId: 'parent-1',
        laneId: LANE_ID,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: '' },
        boostOf: 'original-1',
        laneId: LANE_ID,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(constructedWith).toHaveLength(0);
  });

  it('scopes the ownership lookup to the author', async () => {
    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'in a lane' },
      laneId: LANE_ID,
      skipNotifications: true,
    });

    expect(laneExists).toHaveBeenCalledWith({
      _id: LANE_ID,
      ownerType: 'user',
      ownerId: USER_ID,
    });
  });
});
