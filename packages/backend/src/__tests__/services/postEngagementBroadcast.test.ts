import {
  POST_ENGAGEMENT_EVENTS,
  postEngagementRoom,
  type PostEngagementCountsPayload,
} from '@mention/shared-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Emission {
  room: string;
  event: string;
  payload: PostEngagementCountsPayload;
}

const emissions: Emission[] = [];
const socketServer = {
  to: (room: string) => ({
    emit: (event: string, payload: PostEngagementCountsPayload) => {
      emissions.push({ room, event, payload });
    },
  }),
};
let runtimeSocketServer: typeof socketServer | undefined = socketServer;

vi.mock('../../runtime/socketServer', () => ({
  getRuntimeSocketServer: () => runtimeSocketServer,
}));

const findOne = vi.fn();
vi.mock('../../models/UserSettings', () => ({
  UserSettings: {
    findOne: (...args: unknown[]) => findOne(...args),
  },
}));

const { broadcastPostEngagement } = await import('../../services/postEngagementBroadcast');

/** `UserSettings.findOne(...).select(...).lean()` reduced to its answer. */
function settingsReturning(privacy: Record<string, boolean> | null): void {
  findOne.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(privacy ? { privacy } : null) }),
  });
}

function settingsThatThrow(): void {
  findOne.mockReturnValue({
    select: () => ({ lean: () => Promise.reject(new Error('mongo unavailable')) }),
  });
}

describe('post engagement broadcast', () => {
  beforeEach(() => {
    emissions.length = 0;
    findOne.mockReset();
    runtimeSocketServer = socketServer;
    settingsReturning(null);
  });

  it("sends the write's own counters into that post's room", async () => {
    await broadcastPostEngagement({
      event: POST_ENGAGEMENT_EVENTS.LIKED,
      postId: 'post-1',
      authorOxyUserId: 'author-1',
      counts: { likes: 42, downvotes: 1 },
      actorId: 'actor-1',
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0].room).toBe(postEngagementRoom('post-1'));
    expect(emissions[0].event).toBe(POST_ENGAGEMENT_EVENTS.LIKED);
    expect(emissions[0].payload).toMatchObject({
      postId: 'post-1',
      likesCount: 42,
      downvotesCount: 1,
      actorId: 'actor-1',
    });
  });

  it('omits a counter the author hides rather than sending it', async () => {
    settingsReturning({ hideLikeCounts: true });

    await broadcastPostEngagement({
      event: POST_ENGAGEMENT_EVENTS.LIKED,
      postId: 'post-1',
      authorOxyUserId: 'author-1',
      counts: { likes: 42, downvotes: 1 },
      actorId: 'actor-1',
    });

    // Not `likesCount: null`, not `0` — absent, so no client can render it.
    expect(emissions).toHaveLength(0);
  });

  it('still sends the counters the author does not hide', async () => {
    settingsReturning({ hideLikeCounts: true });

    await broadcastPostEngagement({
      event: POST_ENGAGEMENT_EVENTS.REPLIED,
      postId: 'post-1',
      authorOxyUserId: 'author-1',
      counts: { likes: 42, replies: 9 },
      actorId: 'actor-1',
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0].payload.repliesCount).toBe(9);
    expect(emissions[0].payload.likesCount).toBeUndefined();
  });

  it.each([
    ['hideShareCounts', { boosts: 4 }, POST_ENGAGEMENT_EVENTS.BOOSTED],
    ['hideReplyCounts', { replies: 4 }, POST_ENGAGEMENT_EVENTS.REPLIED],
    ['hideSaveCounts', { saves: 4 }, POST_ENGAGEMENT_EVENTS.SAVED],
  ] as const)('honours %s', async (flag, counts, event) => {
    settingsReturning({ [flag]: true });

    await broadcastPostEngagement({
      event,
      postId: 'post-1',
      authorOxyUserId: 'author-1',
      counts,
    });

    expect(emissions).toHaveLength(0);
  });

  it('never names the actor of a save', async () => {
    await broadcastPostEngagement({
      event: POST_ENGAGEMENT_EVENTS.SAVED,
      postId: 'post-1',
      authorOxyUserId: 'author-1',
      counts: { saves: 8 },
    });

    expect(emissions[0].payload.savesCount).toBe(8);
    expect(emissions[0].payload.actorId).toBeUndefined();
  });

  it('shows the counters when the settings read fails, as the DTO does', async () => {
    settingsThatThrow();

    await broadcastPostEngagement({
      event: POST_ENGAGEMENT_EVENTS.LIKED,
      postId: 'post-1',
      authorOxyUserId: 'author-1',
      counts: { likes: 42 },
    });

    expect(emissions[0].payload.likesCount).toBe(42);
  });

  it('is a no-op with no socket server bound', async () => {
    runtimeSocketServer = undefined;

    await expect(
      broadcastPostEngagement({
        event: POST_ENGAGEMENT_EVENTS.LIKED,
        postId: 'post-1',
        counts: { likes: 42 },
      }),
    ).resolves.toBeUndefined();

    expect(emissions).toHaveLength(0);
    expect(findOne).not.toHaveBeenCalled();
  });
});
