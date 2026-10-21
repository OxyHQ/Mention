import { activitySubscriptionMatches } from '../mtn/feed/activitySubscriptionMatches';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { postSubscriptions, userBehaviors } from '../db/schema';
import {
  activitySubscriptionsSource,
  followingSource,
} from '../mtn/feed/engine/sources/forYouSources';
import { updateUserBehavior } from '../db/userProfile/userBehaviorRepository';
import { loadViewerFeedContext } from '../mtn/feed/feedContext';
import { forYouDefinition } from '../mtn/feed/definitions/presets';
import { rankedSessionBinding } from '../mtn/feed/RankedFeedSession';
import { clearServiceScope, seedPost, serviceScope } from './helpers/serviceFixtures';

const scope = serviceScope('activity-feed');
const viewer = scope.user('viewer');
const other = scope.user('other-viewer');
const author = scope.user('author');
const channel = scope.user('channel');
const now = Date.now();
beforeAll(async () => {
  await connectPostgres();
});
afterEach(async () => {
  await clearServiceScope(scope);
  await getDb().delete(userBehaviors).where(eq(userBehaviors.oxyUserId, viewer));
  await getDb()
    .delete(postSubscriptions)
    .where(inArray(postSubscriptions.subscriberId, [viewer, other]));
});
afterAll(async () => {
  await closePostgres();
});

async function context() {
  return {
    ...(await loadViewerFeedContext(viewer, undefined, undefined, [], {
      activitySubscriptions: true,
    })),
    paginationSession: true,
    rankingAsOf: now,
    seenPostIds: [] as string[],
  };
}

describe('bell subscriptions are interest, not follow authorization', () => {
  it('loads the real viewer edge and supplies bounded fresh public posts including accepted channel coauthors', async () => {
    await getDb()
      .insert(postSubscriptions)
      .values([
        { subscriberId: viewer, authorId: author },
        { subscriberId: viewer, authorId: channel },
        { subscriberId: other, authorId: scope.user('unrelated') },
      ]);
    const fresh = await seedPost(scope, { oxyUserId: author, createdAt: new Date(now - 1000) });
    const collab = await seedPost(scope, {
      oxyUserId: scope.user('owner'),
      authorship: [
        { oxyUserId: scope.user('owner'), role: 'owner', status: 'accepted' },
        { oxyUserId: channel, role: 'collaborator', status: 'accepted' },
      ],
      createdAt: new Date(now - 2000),
    });
    await seedPost(scope, {
      oxyUserId: scope.user('owner'),
      authorship: [
        { oxyUserId: scope.user('owner'), role: 'owner', status: 'accepted' },
        { oxyUserId: channel, role: 'collaborator', status: 'pending' },
      ],
      createdAt: new Date(now - 2000),
    });
    await seedPost(scope, {
      oxyUserId: author,
      visibility: PostVisibility.FOLLOWERS_ONLY,
      createdAt: new Date(now - 1000),
    });
    await seedPost(scope, { oxyUserId: author, status: 'draft', createdAt: new Date(now - 1000) });
    await seedPost(scope, { oxyUserId: author, createdAt: new Date(now + 60_000) });
    await seedPost(scope, { oxyUserId: author, createdAt: new Date(now - 4 * 86_400_000) });
    await seedPost(scope, { oxyUserId: scope.user('unrelated'), createdAt: new Date(now - 1000) });
    const ctx = await context();
    expect(new Set(ctx.activitySubscribedAuthorIds)).toEqual(new Set([author, channel]));
    expect(ctx.followingIds).toEqual([]);
    const first = await activitySubscriptionsSource.gather(ctx, {}, 1);
    expect(first.map((post) => post.id)).toEqual([fresh.id]);
    expect(first[0].activitySubscriptionMatch).toBe(true);
    expect(first[0]._unassembled).toBe(true);
    const second = await activitySubscriptionsSource.gather(
      { ...ctx, seenPostIds: [fresh.id] },
      {},
      1,
    );
    expect(second.map((post) => post.id)).toEqual([collab.id]);
    // A deeper coauthored post may first enter through another source; one
    // candidate-bounded authorship lookup still recognizes the bell.
    expect(
      await activitySubscriptionMatches([{ ...collab, authorship: [], _unassembled: true }], ctx),
    ).toEqual(new Map([[collab.id, [channel]]]));
    expect(await followingSource.gather(ctx, { timeline: true }, 20)).toEqual([]);
    expect(
      await activitySubscriptionsSource.gather(
        { currentUserId: other, activitySubscribedAuthorIds: [], rankingAsOf: now },
        {},
        20,
      ),
    ).toEqual([]);
  });
  it.each(['hiddenAuthors', 'mutedAuthors', 'blockedAuthors'] as const)(
    'does not reintroduce a persisted %s bell through SQL; another eligible coauthor remains valid',
    async (field) => {
      await getDb()
        .insert(postSubscriptions)
        .values([
          { subscriberId: viewer, authorId: channel },
          { subscriberId: viewer, authorId: author },
        ]);
      const onlyExcluded = await seedPost(scope, {
        oxyUserId: scope.user('clean-owner'),
        authorship: [
          { oxyUserId: scope.user('clean-owner'), role: 'owner', status: 'accepted' },
          { oxyUserId: channel, role: 'collaborator', status: 'accepted' },
        ],
        createdAt: new Date(now - 1000),
      });
      const mixed = await seedPost(scope, {
        oxyUserId: scope.user('clean-owner'),
        authorship: [
          { oxyUserId: scope.user('clean-owner'), role: 'owner', status: 'accepted' },
          { oxyUserId: channel, role: 'collaborator', status: 'accepted' },
          { oxyUserId: author, role: 'collaborator', status: 'accepted' },
        ],
        createdAt: new Date(now - 2000),
      });
      const before = await context();
      await updateUserBehavior(
        viewer,
        (behavior) => {
          behavior[field] = [channel];
        },
        { createIfMissing: true },
      );
      const after = await context();
      expect(after.userBehavior?.[field]).toEqual([channel]);
      expect(after.activitySubscribedAuthorIds).toEqual([author]);
      expect(rankedSessionBinding(forYouDefinition, after, 20)).not.toBe(
        rankedSessionBinding(forYouDefinition, before, 20),
      );
      // Include the stale edge deliberately: both direct callers and context callers must be safe.
      const stale = { ...after, activitySubscribedAuthorIds: [channel, author] };
      for (const ctx of [
        after,
        stale,
        { ...before, viewerPrivacy: { blockedIds: [channel], restrictedIds: [] } },
      ]) {
        expect((await activitySubscriptionsSource.gather(ctx, {}, 20)).map((p) => p.id)).toEqual([
          mixed.id,
        ]);
        const shells = [onlyExcluded, mixed].map((p) => ({
          ...p,
          authorship: [],
          _unassembled: true,
          activitySubscriptionMatch: true,
        }));
        expect(await activitySubscriptionMatches(shells, ctx)).toEqual(
          new Map([[mixed.id, [author]]]),
        );
      }
    },
  );

  it('removing a bell changes continuation binding and removes that dedicated supply without touching follows', async () => {
    await getDb().insert(postSubscriptions).values({ subscriberId: viewer, authorId: author });
    await seedPost(scope, { oxyUserId: author, createdAt: new Date(now - 1000) });
    const before = await context();
    expect(await activitySubscriptionsSource.gather(before, {}, 20)).toHaveLength(1);
    await getDb().delete(postSubscriptions).where(eq(postSubscriptions.subscriberId, viewer));
    const after = await context();
    expect(after.activitySubscribedAuthorIds).toEqual([]);
    expect(rankedSessionBinding(forYouDefinition, before, 20)).not.toBe(
      rankedSessionBinding(forYouDefinition, after, 20),
    );
    expect(after.followingIds).toEqual(before.followingIds);
    expect(await activitySubscriptionsSource.gather(after, {}, 20)).toEqual([]);
    expect((await loadViewerFeedContext(viewer, undefined)).activitySubscribedAuthorIds).toEqual(
      [],
    );
  });
});
