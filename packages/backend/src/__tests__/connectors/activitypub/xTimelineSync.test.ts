import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * An X account's timeline, read through FxTwitter (`connectors/activitypub/xTimeline.ts`).
 *
 *  1. A sync of a bird.makeup actor takes its candidates from the listed
 *     timeline: an own tweet is fetched at its bridge status URI, a retweet is an
 *     `Announce` of the original under the minted repost id, dated no later than
 *     the own tweet listed above it. What is held is not fetched, and paging
 *     stops at a page on which everything is held.
 *  2. The bridge's own `Announce` of a retweet the account already holds (under
 *     the minted id) is the same retweet: no second boost.
 *
 * FxTwitter and the bridge are not reached; the held lookup and the boost dedup
 * are real rows.
 */

vi.mock('../../../connectors/activitypub/xTimeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../connectors/activitypub/xTimeline')>()),
  fetchXTimelinePage: vi.fn(),
}));
vi.mock('../../../connectors/activitypub/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../connectors/activitypub/helpers')>()),
  fetchActivityPubObject: vi.fn(),
}));

import { PostType } from '@mention/shared-types';
import { and, eq } from 'drizzle-orm';
import { fetchActivityPubObject } from '../../../connectors/activitypub/helpers';
import { outboxSyncService } from '../../../connectors/activitypub/outbox.service';
import {
  bridgeActorUri,
  bridgeStatusUri,
  fetchXTimelinePage,
  repostActivityId,
} from '../../../connectors/activitypub/xTimeline';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { clearServiceScope, seedPost, serviceScope } from '../../helpers/serviceFixtures';

const scope = serviceScope('x-timeline-sync');
const BOOSTER = scope.user('booster');

const handle = `xtl${Date.now() % 1_000_000}`;
const unique = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('X timeline sync', () => {
  it('collects the fresh own tweets and retweets, and stops at a fully held page', async () => {
    const heldId = unique();
    const heldDeeperId = `${heldId}1`;
    await seedPost(scope, { federation: { activityId: bridgeStatusUri(handle, heldId) } });
    await seedPost(scope, { federation: { activityId: bridgeStatusUri(handle, heldDeeperId) } });

    // Written 2026-11-06T18:53:12.543Z; the retweeted original at 11:26:16.810Z.
    const ownId = '2118778745305653399';
    const originalId = '2118666271969448321';
    vi.mocked(fetchXTimelinePage)
      .mockResolvedValueOnce({
        entries: [
          { kind: 'post', id: ownId, reply: false },
          { kind: 'repost', id: originalId, author: 'someone' },
          { kind: 'post', id: heldId, reply: false },
        ],
        next: 'https://api.fxtwitter.com/2/profile/x/statuses?cursor=2',
      })
      .mockResolvedValueOnce({
        entries: [{ kind: 'post', id: heldDeeperId, reply: false }],
        next: 'https://api.fxtwitter.com/2/profile/x/statuses?cursor=3',
      });
    const actorUri = bridgeActorUri(handle);
    vi.mocked(fetchActivityPubObject).mockImplementation(async (uri: string) => ({
      id: uri,
      type: 'Note',
      attributedTo: actorUri,
      content: '<p>a tweet</p>',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    }));
    const importSpy = vi
      .spyOn(
        outboxSyncService as unknown as { importOutboxCandidates: (...args: unknown[]) => unknown },
        'importOutboxCandidates',
      )
      .mockResolvedValue({
        newPostCount: 2,
        existingCount: 0,
        importedBoostCount: 0,
        healedMentionCount: 0,
        pendingAuthorCount: 0,
      });

    await outboxSyncService.syncOutboxPostsDetailed({
      uri: actorUri,
      acct: `${handle}@bird.makeup`,
      outboxUrl: `${actorUri}/outbox`,
      followersUrl: undefined,
      lastFetchedAt: undefined,
    } as Parameters<typeof outboxSyncService.syncOutboxPostsDetailed>[0]);

    expect(fetchXTimelinePage).toHaveBeenCalledTimes(2);
    expect(fetchActivityPubObject).toHaveBeenCalledTimes(1);
    expect(fetchActivityPubObject).toHaveBeenCalledWith(bridgeStatusUri(handle, ownId));
    const candidates = importSpy.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      kind: 'note',
      activityId: bridgeStatusUri(handle, ownId),
    });
    expect(candidates[1]).toMatchObject({
      kind: 'announce',
      activityId: repostActivityId(handle, originalId),
      announcedUri: bridgeStatusUri('someone', originalId),
      activity: { actor: actorUri, published: '2026-11-06T18:53:12.543Z' },
    });
  });

  it("does not boost twice when the bridge's Announce meets a retweet already held", async () => {
    const originalId = unique();
    const original = await seedPost(scope, {
      federation: { activityId: bridgeStatusUri('someone', originalId) },
    });
    await seedPost(scope, {
      oxyUserId: BOOSTER,
      type: PostType.BOOST,
      boostOf: original.id,
      content: { text: '' },
      federation: { activityId: repostActivityId(handle, originalId) },
    });

    const created = await outboxSyncService.importAnnounce(
      {
        id: `${bridgeActorUri(handle)}/statuses/${unique()}/activity`,
        type: 'Announce',
        actor: bridgeActorUri(handle),
      },
      bridgeStatusUri('someone', originalId),
      BOOSTER,
    );

    expect(created).toBe(false);
    const boosts = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.boostOf, original.id), eq(posts.oxyUserId, BOOSTER)));
    expect(boosts).toHaveLength(1);
  });
});
