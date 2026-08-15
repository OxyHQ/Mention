/**
 * The engagement write path and its outbox, against REAL Postgres rows.
 *
 * ## Why one file for two modules
 *
 * `claimEngagementOutboxEvent` and `dispatchEngagementOutbox` are GLOBAL over
 * `engagement_outbox` — they claim the oldest due row, whoever wrote it. Vitest
 * runs test FILES in parallel, so a second file writing outbox rows would have
 * them silently claimed, leased and completed by this one's dispatcher. Tests
 * inside a file run sequentially, so keeping the only two producers of those
 * rows together is what makes every assertion below deterministic rather than
 * usually-true. Do not move either half out without giving the queue a different
 * form of isolation.
 *
 * ## What replaced what
 *
 * The suites this supersedes (`PostEngagementCommandService.test.ts`,
 * `EngagementOutboxService.test.ts`, `engagementOutboxWrites.test.ts`) asserted
 * against mocked Mongoose models — they read the UPDATE DOCUMENT a call was
 * built with, and could not tell a correct write from one Mongo would refuse.
 * That is exactly how the `ConflictingUpdateOperators` outage shipped green.
 * Every assertion here reads a row back.
 *
 * Two of those files' hardest-won properties are carried over rather than
 * dropped, because they are about the durable contract and not about Mongo:
 * a repeated save writes NOTHING, and a replayed enqueue writes nothing AND
 * therefore cannot block on a dispatcher's live lease.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { sqlStateOf } from '@oxyhq/db';
import { bookmarks, likes } from '../../db/schema/engagement';
import { engagementOutbox } from '../../db/schema/outbox';
import { posts } from '../../db/schema/posts';
import {
  EngagementPostNotFoundError,
  materializeEngagementRelationship,
  materializeEngagementTombstone,
  removeVoteCommand,
  savePostCommand,
  unsavePostCommand,
  votePostCommand,
} from '../../services/PostEngagementCommandService';
import {
  claimEngagementOutboxEvent,
  completeEngagementOutboxEvent,
  dispatchEngagementOutbox,
  enqueueEngagementOutboxEvent,
  engagementOutboxEventId,
  failEngagementOutboxEvent,
  renewEngagementOutboxEvent,
} from '../../services/EngagementOutboxService';

/**
 * The actor id the atomicity probe trigger below refuses to accept. Scoping the
 * trigger to one actor rather than to the table is what keeps it invisible to
 * every other suite sharing this database.
 */
const ATOMICITY_PROBE_ACTOR = 'engagement-atomicity-probe';

let db: Database;
const createdPostIds: string[] = [];

async function seedPost(overrides: { oxyUserId?: string; federationActivityId?: string } = {}) {
  const [post] = await db
    .insert(posts)
    .values({
      oxyUserId: overrides.oxyUserId ?? 'oxy-post-owner',
      ...(overrides.federationActivityId
        ? { federationActivityId: overrides.federationActivityId }
        : {}),
    })
    .returning({ id: posts.id });
  if (!post) throw new Error('Failed to seed a post');
  createdPostIds.push(post.id);
  return post.id;
}

async function outboxRow(eventId: string) {
  const [row] = await db
    .select()
    .from(engagementOutbox)
    .where(eq(engagementOutbox.id, eventId));
  return row;
}

async function postRow(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId));
  return row;
}

beforeAll(async () => {
  db = await connectPostgres();
  // A deterministic mid-transaction failure. `savePostCommand` writes the
  // bookmark and the counter BEFORE the outbox row, so a refused insert here is
  // the only clean way to ask "did the earlier writes survive?".
  // The actor id is spliced as a LITERAL, not bound: a `$1` inside a function
  // body has no inferable type and Postgres refuses the whole DDL (42P18). It is
  // a local `const` of identifier-shaped characters, never a runtime value.
  await db.execute(sql`
    create or replace function engagement_outbox_atomicity_probe() returns trigger as $$
    begin
      if new.payload_actor_oxy_user_id = ${sql.raw(`'${ATOMICITY_PROBE_ACTOR}'`)} then
        raise exception 'engagement outbox atomicity probe';
      end if;
      return new;
    end;
    $$ language plpgsql;
  `);
  await db.execute(sql`
    create or replace trigger engagement_outbox_atomicity_probe_trigger
    before insert on engagement_outbox
    for each row execute function engagement_outbox_atomicity_probe();
  `);
});

afterEach(async () => {
  if (createdPostIds.length > 0) {
    // Likes, bookmarks and outbox events all reference `posts` with
    // ON DELETE CASCADE, so one delete clears the whole test's rows.
    await db.delete(posts).where(inArray(posts.id, createdPostIds));
    createdPostIds.length = 0;
  }
});

afterAll(async () => {
  await db.execute(
    sql`drop trigger if exists engagement_outbox_atomicity_probe_trigger on engagement_outbox`,
  );
  await db.execute(sql`drop function if exists engagement_outbox_atomicity_probe()`);
  await closePostgres();
});

describe('a save writes the relationship, the counter and the event together', () => {
  it('creates all three and reports the counter it actually stored', async () => {
    const postId = await seedPost({ oxyUserId: 'oxy-author-1' });

    const result = await savePostCommand({ userId: 'viewer-a', postId });

    expect(result.changed).toBe(true);
    // Exact and NON-ZERO, against rows written in this test. A correlated
    // predicate that resolves against the wrong table returns zero happily.
    expect(result.post.statsSavesCount).toBe(1);
    expect((await postRow(postId))?.statsSavesCount).toBe(1);

    const stored = await db
      .select()
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, 'viewer-a'), eq(bookmarks.postId, postId)));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(result.bookmarkId);
    // "Unfiled" is NULL. An empty string is a VALUE and would collide for real
    // in the partial unique folder index.
    expect(stored[0]?.folder).toBeNull();

    const event = await outboxRow(result.outboxEventId ?? '');
    expect(event).toMatchObject({
      kind: 'post.save',
      revision: 1,
      status: 'pending',
      attempts: 0,
      payloadActorOxyUserId: 'viewer-a',
      payloadPostId: postId,
      payloadRelationshipId: result.bookmarkId,
      payloadPostOwnerOxyUserId: 'oxy-author-1',
    });
    expect(event?.id).toBe(`engagement:post.save:${result.bookmarkId}:v1`);
  });

  it('records the federation activity id so an Undo can be addressed later', async () => {
    const postId = await seedPost({
      federationActivityId: 'https://remote.example/activities/1',
    });

    const result = await votePostCommand({ userId: 'viewer-a', postId, value: 1 });

    expect((await outboxRow(result.outboxEventId ?? ''))?.payloadFederationActivityId)
      .toBe('https://remote.example/activities/1');
  });

  it('a duplicate save writes NOTHING — not even updated_at', async () => {
    /**
     * A row that was rewritten is still one row, so a count cannot discriminate
     * the idempotent no-op from a real second write; only the timestamps can.
     * The wait is load-bearing: without it an unchanged `updated_at` could be
     * same-instant luck.
     */
    const postId = await seedPost();
    const first = await savePostCommand({ userId: 'viewer-a', postId });
    const before = await db
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.id, first.bookmarkId ?? ''));

    await new Promise((resolve) => setTimeout(resolve, 25));
    const duplicate = await savePostCommand({ userId: 'viewer-a', postId });
    const after = await db
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.id, first.bookmarkId ?? ''));

    expect(duplicate.changed).toBe(false);
    expect(duplicate.bookmarkId).toBeUndefined();
    expect(duplicate.outboxEventId).toBeUndefined();
    // The counter did not move a second time, which is the whole point.
    expect(duplicate.post.statsSavesCount).toBe(1);
    expect(after[0]?.updatedAt.getTime()).toBe(before[0]?.updatedAt.getTime());
    expect(after[0]?.createdAt.getTime()).toBe(before[0]?.createdAt.getTime());
  });

  it('unsaves idempotently and emits the removal event only when a row existed', async () => {
    const postId = await seedPost();
    const saved = await savePostCommand({ userId: 'viewer-a', postId });

    const removed = await unsavePostCommand({ userId: 'viewer-a', postId });
    const repeat = await unsavePostCommand({ userId: 'viewer-a', postId });

    expect(removed).toMatchObject({
      changed: true,
      bookmarkId: saved.bookmarkId,
      outboxEventId: `engagement:post.unsave:${saved.bookmarkId}:v2`,
    });
    expect(removed.post.statsSavesCount).toBe(0);
    expect(repeat.changed).toBe(false);
    expect(repeat.outboxEventId).toBeUndefined();
    expect(
      await db.select().from(bookmarks).where(eq(bookmarks.postId, postId)),
    ).toHaveLength(0);
  });
});

describe('the transaction boundary', () => {
  it('rolls the relationship and the counter back when the event cannot be written', async () => {
    /**
     * THE atomicity assertion. Move `enqueueEngagementOutboxEvent` outside the
     * transaction — or drop the transaction entirely — and this goes red showing
     * the half-applied state: a bookmark and a counter with no durable event, so
     * the save never reaches MTN, federation or notifications and nothing ever
     * retries it.
     */
    const postId = await seedPost();

    // Read the SQLSTATE rather than the message: drizzle re-wraps the driver
    // error as "Failed query: …", so the plpgsql text is only on `cause`.
    // `P0001` is `raise_exception`, i.e. the probe fired and nothing else did.
    const rejection = await savePostCommand({ userId: ATOMICITY_PROBE_ACTOR, postId })
      .then(() => null, (error: unknown) => error);
    expect(rejection).not.toBeNull();
    expect(sqlStateOf(rejection)).toBe('P0001');

    expect(
      await db.select().from(bookmarks).where(eq(bookmarks.postId, postId)),
    ).toHaveLength(0);
    expect((await postRow(postId))?.statsSavesCount).toBe(0);
    expect(
      await db
        .select()
        .from(engagementOutbox)
        .where(eq(engagementOutbox.payloadPostId, postId)),
    ).toHaveLength(0);
  });

  it('keeps the counter honest when several viewers save the same post at once', async () => {
    const postId = await seedPost();
    const viewers = ['race-1', 'race-2', 'race-3', 'race-4', 'race-5'];

    const results = await Promise.all(
      viewers.map((userId) => savePostCommand({ userId, postId })),
    );

    expect(results.every((result) => result.changed)).toBe(true);
    expect((await postRow(postId))?.statsSavesCount).toBe(viewers.length);
    expect(
      await db.select().from(bookmarks).where(eq(bookmarks.postId, postId)),
    ).toHaveLength(viewers.length);
  });

  it('restarts and observes the winner when it loses the relationship race', async () => {
    /**
     * The relationship-race retry, staged DETERMINISTICALLY rather than left to
     * whether two real requests happen to interleave — the branch it exercises
     * is the difference between an idempotent answer and a 500, so a test that
     * only usually reaches it is not a gate.
     *
     * A transaction holds an uncommitted `likes` row for this pair. The command
     * therefore SELECTs and sees nothing, then blocks on the uncommitted unique
     * key; when the holder commits, its `ON CONFLICT DO NOTHING` insert returns
     * no row, and the only correct response is to restart the whole command and
     * read what the winner wrote.
     */
    const postId = await seedPost();
    let releaseWinner = (): void => undefined;
    const winnerCommitted = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const winner = db.transaction(async (tx) => {
      await tx
        .insert(likes)
        .values({ userId: 'self-race', postId, value: 1, revision: 1 });
      await winnerCommitted;
    });
    // Let the insert above take the key before the command reads.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const racing = votePostCommand({ userId: 'self-race', postId, value: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseWinner();
    await winner;
    const result = await racing;

    expect(result).toMatchObject({ changed: false, previousValue: 1, value: 1 });
    expect(
      await db.select().from(likes).where(eq(likes.postId, postId)),
    ).toHaveLength(1);
  });

  it('keeps the counter honest when several viewers vote at once', async () => {
    const postId = await seedPost();
    const viewers = ['vote-1', 'vote-2', 'vote-3', 'vote-4', 'vote-5'];

    const results = await Promise.all(
      viewers.map((userId) => votePostCommand({ userId, postId, value: 1 })),
    );

    expect(results.every((result) => result.changed)).toBe(true);
    expect((await postRow(postId))?.statsLikesCount).toBe(viewers.length);
  });
});

describe('votes move both counters and carry the transition', () => {
  it('creates a first upvote', async () => {
    const postId = await seedPost();

    const result = await votePostCommand({
      userId: 'viewer-a',
      postId,
      value: 1,
      source: 'videos',
    });

    expect(result).toMatchObject({ changed: true, previousValue: null, value: 1 });
    expect(result.post.statsLikesCount).toBe(1);
    expect(result.post.statsDownvotesCount).toBe(0);
    const [stored] = await db.select().from(likes).where(eq(likes.postId, postId));
    expect(stored).toMatchObject({ value: 1, revision: 1, source: 'videos' });
    expect(result.outboxEventId).toBe(`engagement:post.like:${stored?.id}:v1`);
  });

  it('creates a first downvote without touching the like counter', async () => {
    const postId = await seedPost();

    const result = await votePostCommand({ userId: 'viewer-a', postId, value: -1 });

    expect(result.post.statsDownvotesCount).toBe(1);
    expect(result.post.statsLikesCount).toBe(0);
    expect(result.outboxEventId).toBe(`engagement:post.downvote:${result.likeId}:v1`);
  });

  it('switches an upvote to a downvote, bumping the revision and both counters', async () => {
    const postId = await seedPost();
    const first = await votePostCommand({ userId: 'viewer-a', postId, value: 1 });

    const switched = await votePostCommand({ userId: 'viewer-a', postId, value: -1 });

    expect(switched).toMatchObject({
      changed: true,
      likeId: first.likeId,
      previousValue: 1,
      value: -1,
    });
    expect(switched.post.statsLikesCount).toBe(0);
    expect(switched.post.statsDownvotesCount).toBe(1);
    const [stored] = await db.select().from(likes).where(eq(likes.postId, postId));
    expect(stored?.revision).toBe(2);
    // The revision is what makes the second transition a DIFFERENT durable
    // event rather than a replay of the first.
    expect(switched.outboxEventId).toBe(`engagement:post.downvote:${first.likeId}:v2`);
    const event = await outboxRow(switched.outboxEventId ?? '');
    expect(event).toMatchObject({ payloadPreviousValue: 1, payloadValue: -1 });
  });

  it('answers an unchanged vote without writing anything', async () => {
    const postId = await seedPost();
    const first = await votePostCommand({ userId: 'viewer-a', postId, value: 1 });

    const repeat = await votePostCommand({ userId: 'viewer-a', postId, value: 1 });

    expect(repeat).toMatchObject({
      changed: false,
      likeId: first.likeId,
      previousValue: 1,
      value: 1,
    });
    expect(repeat.outboxEventId).toBeUndefined();
    expect((await postRow(postId))?.statsLikesCount).toBe(1);
    expect(
      await db
        .select()
        .from(engagementOutbox)
        .where(eq(engagementOutbox.payloadPostId, postId)),
    ).toHaveLength(1);
  });

  it.each([
    { value: 1 as const, kind: 'post.unlike', counter: 'statsLikesCount' as const },
    { value: -1 as const, kind: 'post.undownvote', counter: 'statsDownvotesCount' as const },
  ])('removes a $kind vote and decrements only its own counter', async ({
    value,
    kind,
    counter,
  }) => {
    const postId = await seedPost();
    const cast = await votePostCommand({ userId: 'viewer-a', postId, value });

    const removed = await removeVoteCommand({ userId: 'viewer-a', postId });

    expect(removed).toMatchObject({ changed: true, previousValue: value, value: null });
    expect(removed.post[counter]).toBe(0);
    expect(removed.outboxEventId).toBe(`engagement:${kind}:${cast.likeId}:v2`);
    expect(await db.select().from(likes).where(eq(likes.postId, postId))).toHaveLength(0);
  });

  it('answers a removal with no vote to remove', async () => {
    const postId = await seedPost();

    const removed = await removeVoteCommand({ userId: 'viewer-a', postId });

    expect(removed).toMatchObject({ changed: false, previousValue: null, value: null });
    expect(removed.outboxEventId).toBeUndefined();
  });

  it('clamps a counter a legacy writer left behind rather than driving it negative', async () => {
    const postId = await seedPost();
    await votePostCommand({ userId: 'viewer-a', postId, value: 1 });
    // A counter that already disagrees with reality — what the reconciliation
    // sweep exists to repair. A decrement must not make it worse.
    await db.update(posts).set({ statsLikesCount: 0 }).where(eq(posts.id, postId));

    const removed = await removeVoteCommand({ userId: 'viewer-a', postId });

    expect(removed.post.statsLikesCount).toBe(0);
  });
});

describe('a post that does not exist', () => {
  it.each([
    ['a well-formed id nothing owns', '019845ab-cdef-7123-8456-0123456789ab'],
    ['a 24-char ObjectId hex nothing owns', '65fdc8c8c8c8c8c8c8c8c8c1'],
    ['an id of no recognized shape at all', 'not-an-id'],
  ])('rejects %s without creating an orphan relationship', async (_label, postId) => {
    /**
     * There is deliberately no id-shape guard any more. All three ids take the
     * same path — they match no row — which is the answer the 404 was always
     * built from. A guard that answered early for the third would once again be
     * deciding "not found" from the SHAPE of an id rather than from the data.
     */
    await expect(savePostCommand({ userId: 'viewer-a', postId }))
      .rejects.toBeInstanceOf(EngagementPostNotFoundError);
    await expect(votePostCommand({ userId: 'viewer-a', postId, value: 1 }))
      .rejects.toBeInstanceOf(EngagementPostNotFoundError);
    expect(
      await db.select().from(bookmarks).where(eq(bookmarks.postId, postId)),
    ).toHaveLength(0);
  });
});

describe('materializing a verified MTN relationship', () => {
  it('preserves the signed rkey as the row id and emits no outbox event', async () => {
    const postId = await seedPost();
    const rkey = '65fdc8c8c8c8c8c8c8c8c8f1';

    const result = await materializeEngagementRelationship({
      kind: 'like',
      relationshipId: rkey,
      userId: 'oxy-node-user',
      postId,
    });

    expect(result).toEqual({ changed: true });
    const [stored] = await db.select().from(likes).where(eq(likes.id, rkey));
    expect(stored).toMatchObject({ userId: 'oxy-node-user', postId, value: 1 });
    expect((await postRow(postId))?.statsLikesCount).toBe(1);
    // The record was already signed and appended; re-emitting it would sign it
    // twice and federate a Like the origin never made.
    expect(
      await db
        .select()
        .from(engagementOutbox)
        .where(eq(engagementOutbox.payloadPostId, postId)),
    ).toHaveLength(0);
  });

  it('is a no-op for a replayed rkey AND for the same pair under a new rkey', async () => {
    /**
     * The second half is a behaviour change worth naming. Mongo's upsert filtered
     * on `_id` alone, so a second rkey for a pair that already had a row hit the
     * compound unique index, exhausted the retry loop and THREW — from a function
     * whose contract is idempotency. `ON CONFLICT DO NOTHING` with no target
     * answers for both indexes, so both replays are the same `changed: false`.
     */
    const postId = await seedPost();
    const rkey = '65fdc8c8c8c8c8c8c8c8c8f2';
    await materializeEngagementRelationship({
      kind: 'like',
      relationshipId: rkey,
      userId: 'oxy-node-user',
      postId,
    });

    await expect(
      materializeEngagementRelationship({
        kind: 'like',
        relationshipId: rkey,
        userId: 'oxy-node-user',
        postId,
      }),
    ).resolves.toEqual({ changed: false });
    await expect(
      materializeEngagementRelationship({
        kind: 'like',
        relationshipId: '65fdc8c8c8c8c8c8c8c8c8f3',
        userId: 'oxy-node-user',
        postId,
      }),
    ).resolves.toEqual({ changed: false });
    expect((await postRow(postId))?.statsLikesCount).toBe(1);
  });

  it('generates an id when the protocol supplied none', async () => {
    const postId = await seedPost();

    await expect(
      materializeEngagementRelationship({
        kind: 'bookmark',
        userId: 'oxy-node-user',
        postId,
      }),
    ).resolves.toEqual({ changed: true });

    const [stored] = await db.select().from(bookmarks).where(eq(bookmarks.postId, postId));
    expect(stored?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/i);
    expect((await postRow(postId))?.statsSavesCount).toBe(1);
  });

  it('rejects a post that does not exist with the typed error', async () => {
    // A FRESH id, not a hardcoded one. Vitest runs files in parallel against one
    // database, so "this post does not exist" is only true if no other file can
    // have created it — and one could: `searchPosts.test.ts` seeds the literal
    // `65fdc8c8c8c8c8c8c8c8c8c9` this used to name, which made the assertion fail
    // in a full run and pass in isolation. An absence assertion must own its id.
    await expect(
      materializeEngagementRelationship({
        kind: 'like',
        userId: 'oxy-node-user',
        postId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(EngagementPostNotFoundError);
  });

  it('tombstones only the actor’s own relationship', async () => {
    const postId = await seedPost();
    await materializeEngagementRelationship({
      kind: 'like',
      relationshipId: '65fdc8c8c8c8c8c8c8c8c8f4',
      userId: 'oxy-owner',
      postId,
    });

    // A valid record from another account naming the same rkey must not remove it.
    await expect(
      materializeEngagementTombstone({
        kind: 'like',
        relationshipId: '65fdc8c8c8c8c8c8c8c8c8f4',
        userId: 'oxy-impostor',
      }),
    ).resolves.toEqual({ changed: false });
    expect((await postRow(postId))?.statsLikesCount).toBe(1);

    await expect(
      materializeEngagementTombstone({
        kind: 'like',
        relationshipId: '65fdc8c8c8c8c8c8c8c8c8f4',
        userId: 'oxy-owner',
      }),
    ).resolves.toEqual({ changed: true });
    expect((await postRow(postId))?.statsLikesCount).toBe(0);
  });

  it('never tombstones a downvote through a like record', async () => {
    const postId = await seedPost();
    await votePostCommand({ userId: 'oxy-owner', postId, value: -1 });

    await expect(
      materializeEngagementTombstone({ kind: 'like', postId, userId: 'oxy-owner' }),
    ).resolves.toEqual({ changed: false });
    expect((await postRow(postId))?.statsDownvotesCount).toBe(1);
  });

  it('removes a bookmark addressed by post and decrements the saves counter', async () => {
    const postId = await seedPost();
    await materializeEngagementRelationship({
      kind: 'bookmark',
      userId: 'oxy-owner',
      postId,
    });

    await expect(
      materializeEngagementTombstone({ kind: 'bookmark', postId, userId: 'oxy-owner' }),
    ).resolves.toEqual({ changed: true });
    expect((await postRow(postId))?.statsSavesCount).toBe(0);
  });

  it('refuses a tombstone that names neither a relationship nor a post', async () => {
    await expect(
      materializeEngagementTombstone({ kind: 'bookmark', userId: 'oxy-owner' }),
    ).rejects.toThrow('needs a relationship or post id');
  });
});

describe('the durable event id', () => {
  it('is derived from the relationship transition, not the request', () => {
    expect(engagementOutboxEventId('post.like', 'like-1', 3))
      .toBe('engagement:post.like:like-1:v3');
    expect(engagementOutboxEventId('post.like', 'like-1', 3))
      .toBe(engagementOutboxEventId('post.like', 'like-1', 3));
    expect(engagementOutboxEventId('post.like', 'like-1', 4))
      .not.toBe(engagementOutboxEventId('post.like', 'like-1', 3));
    expect(engagementOutboxEventId('post.like', 'like-1', 0))
      .toBe('engagement:post.like:like-1:v1');
    expect(engagementOutboxEventId('post.like', 'like-1', Number.NaN))
      .toBe('engagement:post.like:like-1:v1');
  });
});

describe('enqueueing an event', () => {
  it('stamps the retention ceiling the sweep deletes on', async () => {
    const postId = await seedPost();
    const before = Date.now();

    const eventId = await db.transaction((tx) =>
      enqueueEngagementOutboxEvent(
        {
          kind: 'post.save',
          relationshipId: 'bookmark-expiry',
          revision: 1,
          payload: {
            actorOxyUserId: 'viewer-a',
            postId,
            relationshipId: 'bookmark-expiry',
          },
        },
        tx,
      ),
    );

    const stored = await outboxRow(eventId);
    const retentionMs = 30 * 24 * 60 * 60 * 1_000;
    expect(stored?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + retentionMs);
    // `available_at` and `created_at` describe the same instant, which is what
    // lets the claim's due-gate and its ordering agree.
    expect(stored?.availableAt.getTime()).toBe(stored?.createdAt.getTime());
  });

  it('omits an absent optional rather than storing a value for it', async () => {
    const postId = await seedPost({ oxyUserId: 'oxy-author-2' });

    const eventId = await db.transaction((tx) =>
      enqueueEngagementOutboxEvent(
        {
          kind: 'post.save',
          relationshipId: 'bookmark-optionals',
          revision: 1,
          payload: {
            actorOxyUserId: 'viewer-a',
            postId,
            relationshipId: 'bookmark-optionals',
          },
        },
        tx,
      ),
    );

    const stored = await outboxRow(eventId);
    expect(stored?.payloadPostOwnerOxyUserId).toBeNull();
    expect(stored?.payloadFederationActivityId).toBeNull();
    expect(stored?.payloadPreviousValue).toBeNull();

    // …and the reader hands that back as ABSENT, never as `null`, because every
    // consumer of these two is typed `string | undefined`.
    const claimed = await claimEngagementOutboxEvent({
      leaseOwner: 'optionals-worker',
      eventId,
    });
    expect(claimed?.payload.postOwnerOxyUserId).toBeUndefined();
    expect(claimed?.payload.federationActivityId).toBeUndefined();
    expect(claimed?.payload.previousValue).toBeNull();
  });

  it('a replayed enqueue writes NOTHING, and is therefore delivered once', async () => {
    /**
     * The dedup, and the consequence of losing it in the same test.
     *
     * Break the id derivation — make it non-deterministic, or turn the conflict
     * clause into `DO UPDATE` — and the row count and the DELIVERY count move
     * together: the dispatcher hands the same transition to the handler twice,
     * which downstream is a second signed MTN record under a fresh rkey, a
     * second federated Like the origin never made, and a second notification.
     * Asserting the row alone would let a future change keep one row and still
     * double-deliver; asserting the delivery alone would not say why.
     */
    const postId = await seedPost();
    const enqueue = () =>
      db.transaction((tx) =>
        enqueueEngagementOutboxEvent(
          {
            kind: 'post.like',
            relationshipId: 'like-replay',
            revision: 1,
            payload: {
              actorOxyUserId: 'viewer-b',
              postId,
              relationshipId: 'like-replay',
            },
          },
          tx,
        ),
      );

    const eventId = await enqueue();
    const before = await outboxRow(eventId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const replayed = await enqueue();
    const after = await outboxRow(eventId);

    expect(replayed).toBe(eventId);
    expect(
      await db
        .select()
        .from(engagementOutbox)
        .where(eq(engagementOutbox.payloadRelationshipId, 'like-replay')),
    ).toHaveLength(1);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());

    // One transition, one delivery — however many times it was enqueued.
    const handler = vi.fn().mockResolvedValue(undefined);
    const drained = await dispatchEngagementOutbox({
      handler,
      leaseOwner: 'worker-a',
      batchSize: 10,
    });
    expect(drained).toEqual({ processed: 1, failed: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a replayed enqueue lands cleanly on a row a dispatcher is holding', async () => {
    /**
     * The replay under CONTENTION, which is the state that actually occurs: the
     * dispatcher claims, renews and completes leases on these same rows, and a
     * duplicate request can arrive at any point.
     *
     * A measured Postgres behaviour worth writing down, because the Mongo
     * version of this test asserted the opposite and passed: `INSERT … ON
     * CONFLICT DO NOTHING` does NOT sail past a conflicting row that another
     * transaction is mid-UPDATE on — the unique-index probe finds a tuple with
     * an in-progress `xmax` and waits for that transaction to resolve. So the
     * replay is not lock-free here; it is merely SHORT, and it is short only
     * because every lease transition in `EngagementOutboxService` is ONE
     * statement with an implicit commit. Wrap a claim, a renewal or a completion
     * in a transaction that spans the delivery and a duplicate like request
     * starts waiting for that whole delivery. That invariant is the thing to
     * protect; the assertions below are its observable half.
     */
    const postId = await seedPost();
    const payload = {
      actorOxyUserId: 'viewer-c',
      postId,
      relationshipId: 'like-contended',
    };
    const enqueue = () =>
      db.transaction((tx) =>
        enqueueEngagementOutboxEvent(
          { kind: 'post.like', relationshipId: 'like-contended', revision: 1, payload },
          tx,
        ),
      );
    const eventId = await enqueue();

    let releaseDispatcher = (): void => undefined;
    const dispatcherCommitted = new Promise<void>((resolve) => {
      releaseDispatcher = resolve;
    });
    const dispatcherHold = db.transaction(async (tx) => {
      await tx
        .update(engagementOutbox)
        .set({ leaseOwner: 'dispatcher-1' })
        .where(eq(engagementOutbox.id, eventId));
      await dispatcherCommitted;
    });
    // Let the update above actually take its row lock before racing it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const replay = enqueue();
    releaseDispatcher();
    const [replayedId] = await Promise.all([replay, dispatcherHold]);
    const after = await outboxRow(eventId);

    expect(replayedId).toBe(eventId);
    expect(
      await db
        .select()
        .from(engagementOutbox)
        .where(eq(engagementOutbox.payloadRelationshipId, 'like-contended')),
    ).toHaveLength(1);
    // The dispatcher's claim survived the replay untouched. This is the
    // assertion that discriminates the tempting wrong fix: an
    // `ON CONFLICT DO UPDATE` carrying the insert's own values would reset
    // `lease_owner`, `status` and `attempts`, silently un-claiming an event
    // another task is mid-delivery on.
    expect(after?.leaseOwner).toBe('dispatcher-1');
    expect(after?.status).toBe('pending');
    expect(after?.attempts).toBe(0);
  });
});

describe('claiming, leasing and releasing', () => {
  /**
   * Every claim in this block is either scoped to one `eventId` or run with a
   * `now` in the past against rows whose `available_at` is also in the past, so
   * a row belonging to another test can never be due at the same moment.
   */
  const PAST = new Date('2020-01-01T00:00:00.000Z');
  const PAST_CLAIM_AT = new Date('2020-01-02T00:00:00.000Z');

  async function seedDueEvent(
    postId: string,
    relationshipId: string,
    createdAt: Date,
  ): Promise<string> {
    const eventId = engagementOutboxEventId('post.like', relationshipId, 1);
    await db.insert(engagementOutbox).values({
      id: eventId,
      kind: 'post.like',
      revision: 1,
      payloadActorOxyUserId: 'viewer-a',
      payloadPostId: postId,
      payloadRelationshipId: relationshipId,
      status: 'pending',
      attempts: 0,
      availableAt: createdAt,
      expiresAt: new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
      createdAt,
      updatedAt: createdAt,
    });
    return eventId;
  }

  it('takes the oldest due event first and counts the attempt', async () => {
    const postId = await seedPost();
    const newer = await seedDueEvent(postId, 'claim-newer', new Date(PAST.getTime() + 60_000));
    const older = await seedDueEvent(postId, 'claim-older', PAST);

    const first = await claimEngagementOutboxEvent({
      leaseOwner: 'worker-a',
      now: PAST_CLAIM_AT,
    });
    const second = await claimEngagementOutboxEvent({
      leaseOwner: 'worker-a',
      now: PAST_CLAIM_AT,
    });

    expect(first?.id).toBe(older);
    expect(second?.id).toBe(newer);
    expect(first?.attempts).toBe(1);
    expect(first?.leaseOwner).toBe('worker-a');
    expect((await outboxRow(older))?.status).toBe('processing');
  });

  it('gives one row to exactly one of two workers racing for it', async () => {
    const postId = await seedPost();
    const eventId = await seedDueEvent(postId, 'claim-contended', PAST);

    const [left, right] = await Promise.all([
      claimEngagementOutboxEvent({ leaseOwner: 'worker-a', eventId, now: PAST_CLAIM_AT }),
      claimEngagementOutboxEvent({ leaseOwner: 'worker-b', eventId, now: PAST_CLAIM_AT }),
    ]);

    expect([left, right].filter(Boolean)).toHaveLength(1);
    expect((await outboxRow(eventId))?.attempts).toBe(1);
  });

  it('leaves a live lease alone and reclaims an expired one', async () => {
    const postId = await seedPost();
    const eventId = await seedDueEvent(postId, 'claim-lease', PAST);
    await claimEngagementOutboxEvent({
      leaseOwner: 'worker-a',
      eventId,
      now: PAST_CLAIM_AT,
      leaseMs: 30_000,
    });

    const duringLease = await claimEngagementOutboxEvent({
      leaseOwner: 'worker-b',
      eventId,
      now: new Date(PAST_CLAIM_AT.getTime() + 10_000),
    });
    const afterLease = await claimEngagementOutboxEvent({
      leaseOwner: 'worker-b',
      eventId,
      now: new Date(PAST_CLAIM_AT.getTime() + 40_000),
    });

    expect(duringLease).toBeNull();
    expect(afterLease?.leaseOwner).toBe('worker-b');
    // Reclaiming counts as another attempt, which is what feeds the backoff.
    expect(afterLease?.attempts).toBe(2);
  });

  it('completes, renews and releases only for the owner that holds the lease', async () => {
    const postId = await seedPost();
    const eventId = await seedDueEvent(postId, 'claim-owner', PAST);
    await claimEngagementOutboxEvent({
      leaseOwner: 'worker-a',
      eventId,
      now: PAST_CLAIM_AT,
      leaseMs: 60_000,
    });
    const at = new Date(PAST_CLAIM_AT.getTime() + 1_000);

    await expect(renewEngagementOutboxEvent(eventId, 'worker-b', 60_000, at))
      .resolves.toBe(false);
    await expect(completeEngagementOutboxEvent(eventId, 'worker-b', at))
      .resolves.toBe(false);
    await expect(
      failEngagementOutboxEvent({ id: eventId, attempts: 1 }, 'worker-b', new Error('x'), at),
    ).resolves.toBe(false);
    expect((await outboxRow(eventId))?.status).toBe('processing');

    await expect(renewEngagementOutboxEvent(eventId, 'worker-a', 90_000, at))
      .resolves.toBe(true);
    await expect(completeEngagementOutboxEvent(eventId, 'worker-a', at))
      .resolves.toBe(true);
    const completed = await outboxRow(eventId);
    expect(completed?.status).toBe('processed');
    expect(completed?.leaseOwner).toBeNull();
    expect(completed?.processedAt).toBeInstanceOf(Date);
  });

  it('releases a failure with bounded exponential backoff and keeps the reason', async () => {
    const postId = await seedPost();
    const eventId = await seedDueEvent(postId, 'claim-backoff', PAST);
    await claimEngagementOutboxEvent({
      leaseOwner: 'worker-a',
      eventId,
      now: PAST_CLAIM_AT,
      leaseMs: 60_000,
    });
    const at = new Date(PAST_CLAIM_AT.getTime() + 1_000);

    await expect(
      failEngagementOutboxEvent(
        { id: eventId, attempts: 3 },
        'worker-a',
        new Error('downstream unavailable'),
        at,
      ),
    ).resolves.toBe(true);

    const released = await outboxRow(eventId);
    expect(released?.status).toBe('pending');
    expect(released?.lastError).toBe('downstream unavailable');
    expect(released?.leaseOwner).toBeNull();
    // attempts 3 → 2^2 seconds.
    expect(released?.availableAt.getTime()).toBe(at.getTime() + 4_000);
  });
});

describe('dispatching', () => {
  it('delivers an event once and never again, however many passes run', async () => {
    /**
     * The replay guarantee end to end. If the dedup or the completion transition
     * were broken, the second pass would re-claim the same row and the handler
     * would fire twice — a second signed MTN record and a second federated Like.
     */
    const postId = await seedPost();
    const saved = await savePostCommand({ userId: 'viewer-a', postId });
    const handler = vi.fn().mockResolvedValue(undefined);

    const first = await dispatchEngagementOutbox({
      handler,
      leaseOwner: 'worker-a',
      batchSize: 10,
    });
    const second = await dispatchEngagementOutbox({
      handler,
      leaseOwner: 'worker-a',
      batchSize: 10,
    });

    expect(first).toEqual({ processed: 1, failed: 0 });
    expect(second).toEqual({ processed: 0, failed: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      id: saved.outboxEventId,
      kind: 'post.save',
      payload: { actorOxyUserId: 'viewer-a', postId },
    });
    expect((await outboxRow(saved.outboxEventId ?? ''))?.status).toBe('processed');
  });

  it('bounds the batch and mints its own lease owner when the caller names none', async () => {
    /**
     * The two inputs a scheduler can get wrong. A batch size is CLAMPED rather
     * than trusted (a caller asking for 100k would hold one task on the queue
     * indefinitely), and an unnamed dispatcher still needs an owner distinct
     * from every other task's, or two tasks would complete each other's leases.
     */
    const postId = await seedPost();
    const saved = await savePostCommand({ userId: 'viewer-a', postId });

    const result = await dispatchEngagementOutbox({
      handler: vi.fn().mockResolvedValue(undefined),
      batchSize: 10_000,
    });

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect((await outboxRow(saved.outboxEventId ?? ''))?.status).toBe('processed');
  });

  it('runs on its own defaults when the caller passes only a handler', async () => {
    // How `EngagementOutboxDispatcher` would call it with nothing configured.
    const postId = await seedPost();
    const saved = await savePostCommand({ userId: 'viewer-a', postId });

    const result = await dispatchEngagementOutbox({
      handler: vi.fn().mockResolvedValue(undefined),
    });

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect((await outboxRow(saved.outboxEventId ?? ''))?.status).toBe('processed');
  });

  it('claims at least one event even when asked for a batch of zero', async () => {
    const postId = await seedPost();
    await savePostCommand({ userId: 'viewer-a', postId });

    const result = await dispatchEngagementOutbox({
      handler: vi.fn().mockResolvedValue(undefined),
      leaseOwner: 'worker-a',
      batchSize: 0,
    });

    expect(result).toEqual({ processed: 1, failed: 0 });
  });

  it('keeps a failed delivery pending, with the reason, for a later reclaim', async () => {
    const postId = await seedPost();
    const saved = await savePostCommand({ userId: 'viewer-a', postId });

    const result = await dispatchEngagementOutbox({
      handler: vi.fn().mockRejectedValue(new Error('temporary failure')),
      leaseOwner: 'worker-a',
      batchSize: 10,
    });

    expect(result).toEqual({ processed: 0, failed: 1 });
    const stored = await outboxRow(saved.outboxEventId ?? '');
    expect(stored?.status).toBe('pending');
    expect(stored?.lastError).toBe('temporary failure');
    expect(stored?.leaseOwner).toBeNull();
  });

  it('stringifies a non-Error rejection rather than losing the reason', async () => {
    const postId = await seedPost();
    const saved = await savePostCommand({ userId: 'viewer-a', postId });

    await dispatchEngagementOutbox({
      handler: vi.fn().mockRejectedValue('string failure'),
      leaseOwner: 'worker-a',
      batchSize: 10,
    });

    expect((await outboxRow(saved.outboxEventId ?? ''))?.lastError).toBe('string failure');
  });

  it('defers a later revision while an earlier one for the same relationship is unfinished', async () => {
    /**
     * Ordering, and why it matters: applying an unlike before its like would
     * leave a Like standing on the remote instance forever.
     */
    const postId = await seedPost();
    const cast = await votePostCommand({ userId: 'viewer-a', postId, value: 1 });
    const switched = await votePostCommand({ userId: 'viewer-a', postId, value: -1 });
    // Take the earlier revision out of reach so only the later one is claimable.
    await db
      .update(engagementOutbox)
      .set({ availableAt: new Date(Date.now() + 60_000) })
      .where(eq(engagementOutbox.id, cast.outboxEventId ?? ''));
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchEngagementOutbox({
      handler,
      leaseOwner: 'worker-a',
      batchSize: 10,
    });

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(handler).not.toHaveBeenCalled();
    const deferred = await outboxRow(switched.outboxEventId ?? '');
    expect(deferred?.status).toBe('pending');
    expect(deferred?.leaseOwner).toBeNull();
    // The deferral is not a delivery attempt, so it must not feed the backoff.
    expect(deferred?.attempts).toBe(0);
  });

  it('stops claiming new work once shutdown is signalled', async () => {
    const postId = await seedPost();
    await savePostCommand({ userId: 'viewer-a', postId });
    await savePostCommand({ userId: 'viewer-b', postId });
    const controller = new AbortController();
    const handler = vi.fn(async () => {
      controller.abort();
    });

    const result = await dispatchEngagementOutbox({
      handler,
      leaseOwner: 'worker-a',
      batchSize: 100,
      signal: controller.signal,
    });

    // The in-flight event still reaches a durable state; the next one is left
    // pending for the task that takes over.
    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('renews the lease of a delivery that outlives it', async () => {
    /**
     * Without the heartbeat a slow downstream is indistinguishable from a dead
     * worker: the lease expires, another task reclaims the event, and the effect
     * is delivered twice. Real timers on purpose — the thing under test is that
     * the renewal actually reaches the database while the handler is blocked,
     * which a fake clock cannot demonstrate.
     */
    const postId = await seedPost();
    const saved = await savePostCommand({ userId: 'viewer-a', postId });
    const eventId = saved.outboxEventId ?? '';
    const leaseMs = 600;
    const claimedUntil: Date[] = [];

    const result = await dispatchEngagementOutbox({
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, leaseMs * 2));
        const row = await outboxRow(eventId);
        if (row?.leaseUntil) claimedUntil.push(row.leaseUntil);
      },
      leaseOwner: 'worker-a',
      leaseMs,
      batchSize: 1,
    });

    expect(result).toEqual({ processed: 1, failed: 0 });
    // The lease read from inside the handler is in the future relative to the
    // moment the original one would have lapsed.
    expect(claimedUntil).toHaveLength(1);
    expect(claimedUntil[0]?.getTime()).toBeGreaterThan(Date.now());
    expect((await outboxRow(eventId))?.status).toBe('processed');
  }, 10_000);

  it('counts an event whose lease was stolen mid-delivery instead of completing it', async () => {
    const postId = await seedPost();
    const saved = await savePostCommand({ userId: 'viewer-a', postId });
    const eventId = saved.outboxEventId ?? '';

    const result = await dispatchEngagementOutbox({
      handler: async () => {
        // A reclaim by another task while this one is still working — exactly
        // what an expired lease allows.
        await db
          .update(engagementOutbox)
          .set({ leaseOwner: 'worker-b' })
          .where(eq(engagementOutbox.id, eventId));
      },
      leaseOwner: 'worker-a',
      leaseMs: 1_000,
      batchSize: 1,
    });

    expect(result).toEqual({ processed: 0, failed: 1 });
    // Not completed by the loser: the winner still owns it.
    expect((await outboxRow(eventId))?.status).toBe('processing');
    expect((await outboxRow(eventId))?.leaseOwner).toBe('worker-b');
  });

  it('does not release an event it no longer owns, even when its delivery failed', async () => {
    /**
     * The double fault: the delivery threw AND the lease had already been taken
     * over. Releasing here would set the row back to `pending` underneath a task
     * that is actively delivering it, which is how one like becomes two.
     */
    const postId = await seedPost();
    const saved = await savePostCommand({ userId: 'viewer-a', postId });
    const eventId = saved.outboxEventId ?? '';

    const result = await dispatchEngagementOutbox({
      handler: async () => {
        await db
          .update(engagementOutbox)
          .set({ leaseOwner: 'worker-b' })
          .where(eq(engagementOutbox.id, eventId));
        throw new Error('downstream unavailable');
      },
      leaseOwner: 'worker-a',
      leaseMs: 30_000,
      batchSize: 1,
    });

    expect(result).toEqual({ processed: 0, failed: 1 });
    const stored = await outboxRow(eventId);
    expect(stored?.status).toBe('processing');
    expect(stored?.leaseOwner).toBe('worker-b');
    expect(stored?.lastError).toBeNull();
  });
});
