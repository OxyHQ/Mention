import {
  POST_ENGAGEMENT_EVENTS,
  postEngagementRoom,
  type PostEngagementCountsPayload,
} from '@mention/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { userSettings } from '../../db/schema/userProfile';
import { broadcastPostEngagement } from '../../services/postEngagementBroadcast';

/**
 * The author whose privacy decides what may be sent. Namespaced, because vitest
 * runs files in parallel against one database and `user_settings.oxy_user_id` is
 * unique — a bare `'author-1'` is a claim about every other file in the run.
 */
const AUTHOR = 'engagement-broadcast-author';

/**
 * The author's REAL `user_settings` row.
 *
 * The four flags are flat `NOT NULL DEFAULT false` columns, so "no row" and "a
 * row with nothing hidden" are genuinely different states here, and only the
 * first exercises the absent-row arm. `null` writes no row at all.
 */
async function settingsReturning(privacy: Record<string, boolean> | null): Promise<void> {
  await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, AUTHOR));
  if (!privacy) return;
  await getDb()
    .insert(userSettings)
    .values({
      oxyUserId: AUTHOR,
      privacyHideLikeCounts: privacy.hideLikeCounts ?? false,
      privacyHideShareCounts: privacy.hideShareCounts ?? false,
      privacyHideReplyCounts: privacy.hideReplyCounts ?? false,
      privacyHideSaveCounts: privacy.hideSaveCounts ?? false,
    });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await getDb().delete(userSettings).where(eq(userSettings.oxyUserId, AUTHOR));
  await closePostgres();
});

describe('post engagement broadcast', () => {
  beforeEach(async () => {
    emissions.length = 0;
    runtimeSocketServer = socketServer;
    await settingsReturning(null);
  });

  it("sends the write's own counters into that post's room", async () => {
    await broadcastPostEngagement({
      event: POST_ENGAGEMENT_EVENTS.LIKED,
      postId: 'post-1',
      authorOxyUserId: AUTHOR,
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
    await settingsReturning({ hideLikeCounts: true });

    await broadcastPostEngagement({
      event: POST_ENGAGEMENT_EVENTS.LIKED,
      postId: 'post-1',
      authorOxyUserId: AUTHOR,
      counts: { likes: 42, downvotes: 1 },
      actorId: 'actor-1',
    });

    // Not `likesCount: null`, not `0` — absent, so no client can render it.
    expect(emissions).toHaveLength(0);
  });

  it('still sends the counters the author does not hide', async () => {
    await settingsReturning({ hideLikeCounts: true });

    await broadcastPostEngagement({
      event: POST_ENGAGEMENT_EVENTS.REPLIED,
      postId: 'post-1',
      authorOxyUserId: AUTHOR,
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
    await settingsReturning({ [flag]: true });

    await broadcastPostEngagement({
      event,
      postId: 'post-1',
      authorOxyUserId: AUTHOR,
      counts,
    });

    expect(emissions).toHaveLength(0);
  });

  it('never names the actor of a save', async () => {
    await broadcastPostEngagement({
      event: POST_ENGAGEMENT_EVENTS.SAVED,
      postId: 'post-1',
      authorOxyUserId: AUTHOR,
      counts: { saves: 8 },
    });

    expect(emissions[0].payload.savesCount).toBe(8);
    expect(emissions[0].payload.actorId).toBeUndefined();
  });

  /**
   * NOT covered here: the settings-read FAILURE arm.
   *
   * It resolves to the same value as an absent row (show the counters), which is
   * deliberate — the render path falls back to the same defaults, so doing
   * anything else would make the live number and the reloaded number disagree
   * about one failure. Staging it against a live database needs a hook that
   * would itself be fiction, and the arm above already pins the value.
   */

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
  });
});
