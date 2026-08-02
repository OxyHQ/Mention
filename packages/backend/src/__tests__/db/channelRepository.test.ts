/**
 * The channel and lane WRITES that carry an invariant, against real rows.
 *
 * These properties used to live in `models/Channel.ts` and `models/Lane.ts` as
 * a `pre('validate')` hook plus a `required` validator, and their old suites
 * (`__tests__/models/channel.test.ts`, `__tests__/models/lane.test.ts`) asserted
 * them by calling `validate()` on an unsaved document. Neither the hook nor
 * those suites survive the port; the derivation moved to
 * `db/channels/*Repository.ts` and is checked here against what Postgres
 * actually STORED, which is the only thing the unique constraints read.
 *
 * Three of these cases exist because they cannot be reached through the routes:
 *
 *  - **`ChannelHandleError`** is the backstop UNDERNEATH `POST /channels`'s own
 *    400. The route validates first, so the throw is unreachable from HTTP —
 *    the discriminating case has to call the repository directly, which is what
 *    a future second writer would do.
 *  - **A rename that collides** only violates `lanes_owner_name_lower_key` if
 *    the rename moved `name_lower` too. Assert the CONSTRAINT rather than the
 *    column, because a derivation that stopped happening leaves a perfectly
 *    plausible `name` behind and nothing else changes.
 *  - **`deleteChannelCascade` must leave the posts alive.** A test that only
 *    checks `channel_id is null` on a row it fetched would pass on an empty
 *    result, so every one of these asserts the row EXISTS first. Migration
 *    `0012` moved the guarantee under the application — `posts.channel_id` is
 *    now `ON DELETE SET NULL` — and the block near the bottom of this file
 *    exercises that constraint with no repository between it and the row,
 *    because that is the path a background sweep takes.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  CHANNEL_HANDLE_MAX_LENGTH,
  RESERVED_CHANNEL_HANDLES,
  normalizeChannelHandle,
} from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { isUniqueViolation } from '../../db/pgErrors';
import { channelFollows, channelMembers, channels, laneMutes, lanes } from '../../db/schema/channels';
import {
  ChannelHandleError,
  deleteChannelCascade,
  insertChannelWithOwner,
  updateChannelProfile,
} from '../../db/channels/channelRepository';
import {
  insertLane,
  normalizeLaneName,
  updateLane,
} from '../../db/channels/laneRepository';
import { clearPostScope, postScope, readPostRow, seedPost } from '../helpers/postFixtures';

const scope = postScope('channel-repository');

/** Channel ids this file created through the repository, for teardown. */
const createdChannelIds: string[] = [];
/** Lane ids this file created through the repository, for teardown. */
const createdLaneIds: string[] = [];

/** A handle nothing else in the run can hold. Hex is `[a-z0-9]`, so it is legal. */
function uniqueHandle(): string {
  return `c${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

async function readChannel(id: string): Promise<typeof channels.$inferSelect | undefined> {
  const [row] = await getDb().select().from(channels).where(eq(channels.id, id));
  return row;
}

async function readLane(id: string): Promise<typeof lanes.$inferSelect | undefined> {
  const [row] = await getDb().select().from(lanes).where(eq(lanes.id, id));
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearPostScope(scope);
  for (const id of createdLaneIds.splice(0)) {
    await getDb().delete(lanes).where(eq(lanes.id, id));
  }
  for (const id of createdChannelIds.splice(0)) {
    await getDb().delete(channels).where(eq(channels.id, id));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('normalizeChannelHandle — the ONE canonicalizer', () => {
  it('lowercases, trims and drops a leading @', () => {
    expect(normalizeChannelHandle('  @NewsRoom ')).toBe('newsroom');
  });

  it('makes two spellings of one handle collide, which is what the unique index needs', () => {
    expect(normalizeChannelHandle('NewsRoom')).toBe(normalizeChannelHandle('@newsroom'));
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(CHANNEL_HANDLE_MAX_LENGTH + 1)],
    ['a space', 'news room'],
    ['a hyphen', 'news-room'],
    ['a dot', 'news.room'],
    ['a non-ASCII letter', 'notícias'],
    ['empty', ''],
  ])('rejects %s by returning null, never an empty string', (_label, input) => {
    expect(normalizeChannelHandle(input)).toBeNull();
  });

  it('rejects a non-string rather than coercing it', () => {
    expect(normalizeChannelHandle(undefined)).toBeNull();
    expect(normalizeChannelHandle(null)).toBeNull();
  });

  it('rejects every reserved handle, case-insensitively', () => {
    for (const reserved of RESERVED_CHANNEL_HANDLES) {
      expect(normalizeChannelHandle(reserved)).toBeNull();
      expect(normalizeChannelHandle(reserved.toUpperCase())).toBeNull();
    }
  });
});

describe('normalizeLaneName — the ONE definition of a lane name', () => {
  it('trims, collapses inner whitespace and lowercases', () => {
    expect(normalizeLaneName('  Notas   de   Nate  ')).toBe('notas de nate');
  });

  it('collapses to empty for a whitespace-only name', () => {
    expect(normalizeLaneName('   ')).toBe('');
  });

  it('makes two spellings of one name collide, which is what the unique index needs', () => {
    expect(normalizeLaneName('Dev')).toBe(normalizeLaneName('  dev '));
  });
});

describe('insertLane', () => {
  it('derives name_lower rather than taking it from the caller', async () => {
    const lane = await insertLane({
      ownerType: 'user',
      ownerId: scope.user('publisher'),
      name: '  Fotos  De  Viaje ',
      displayMode: 'mixed',
    });
    createdLaneIds.push(lane.id);

    const stored = await readLane(lane.id);
    expect(stored?.name).toBe('  Fotos  De  Viaje ');
    expect(stored?.nameLower).toBe('fotos de viaje');
  });

  it('refuses a second lane whose name normalizes onto an existing one', async () => {
    const owner = scope.user('collider');
    const first = await insertLane({
      ownerType: 'user',
      ownerId: owner,
      name: 'Dev',
      displayMode: 'mixed',
    });
    createdLaneIds.push(first.id);

    await expect(
      insertLane({ ownerType: 'user', ownerId: owner, name: '  DEV  ', displayMode: 'tab' }),
    ).rejects.toSatisfy((error: unknown) =>
      isUniqueViolation(error, 'lanes_owner_name_lower_key'),
    );
  });

  it('scopes uniqueness to the PUBLISHER — a user and a channel may share a name', async () => {
    const name = `lane-${randomUUID().slice(0, 8)}`;
    const mine = await insertLane({
      ownerType: 'user',
      ownerId: scope.user('shared'),
      name,
      displayMode: 'mixed',
    });
    createdLaneIds.push(mine.id);

    const theirs = await insertLane({
      ownerType: 'channel',
      ownerId: 'a-channel-id',
      name,
      displayMode: 'mixed',
    });
    createdLaneIds.push(theirs.id);

    expect(theirs.id).not.toBe(mine.id);
  });
});

describe('updateLane', () => {
  it('moves name_lower with name, so a colliding rename is REFUSED', async () => {
    const owner = scope.user('renamer');
    const alpha = await insertLane({
      ownerType: 'user',
      ownerId: owner,
      name: 'Alpha',
      displayMode: 'mixed',
    });
    createdLaneIds.push(alpha.id);
    const beta = await insertLane({
      ownerType: 'user',
      ownerId: owner,
      name: 'Beta',
      displayMode: 'mixed',
    });
    createdLaneIds.push(beta.id);

    // The CONSTRAINT is the assertion. A rename that wrote `name` and left
    // `name_lower` behind would succeed here and leave the publisher holding two
    // lanes both displayed as "ALPHA" — with no error anywhere.
    await expect(updateLane(beta.id, { name: 'ALPHA' })).rejects.toSatisfy((error: unknown) =>
      isUniqueViolation(error, 'lanes_owner_name_lower_key'),
    );
  });

  it('rewrites name_lower on an accepted rename', async () => {
    const lane = await insertLane({
      ownerType: 'user',
      ownerId: scope.user('rewriter'),
      name: 'Before',
      displayMode: 'mixed',
    });
    createdLaneIds.push(lane.id);

    await updateLane(lane.id, { name: '  After  Words ' });

    const stored = await readLane(lane.id);
    expect(stored?.name).toBe('  After  Words ');
    expect(stored?.nameLower).toBe('after words');
  });

  it('leaves the name alone when only the display mode moves', async () => {
    const lane = await insertLane({
      ownerType: 'user',
      ownerId: scope.user('mover'),
      name: 'Stable',
      displayMode: 'mixed',
    });
    createdLaneIds.push(lane.id);

    const updated = await updateLane(lane.id, { displayMode: 'hidden' });

    expect(updated?.displayMode).toBe('hidden');
    expect(updated?.name).toBe('Stable');
    expect(updated?.nameLower).toBe('stable');
  });

  it('answers null for a lane that does not exist', async () => {
    expect(await updateLane(randomUUID(), { displayMode: 'tab' })).toBeNull();
  });
});

describe('insertChannelWithOwner', () => {
  it('canonicalizes the handle into BOTH columns', async () => {
    const handle = uniqueHandle();
    const channel = await insertChannelWithOwner(`  @${handle.toUpperCase()} `, scope.user('owner'), {
      title: 'A channel',
      signPosts: false,
    });
    createdChannelIds.push(channel.id);

    const stored = await readChannel(channel.id);
    expect(stored?.handle).toBe(handle);
    expect(stored?.handleLower).toBe(handle);
  });

  it('writes the owner\'s ACCEPTED membership row in the same transaction', async () => {
    const owner = scope.user('founder');
    const channel = await insertChannelWithOwner(uniqueHandle(), owner, {
      title: 'A channel',
      signPosts: true,
    });
    createdChannelIds.push(channel.id);

    const [membership] = await getDb()
      .select()
      .from(channelMembers)
      .where(
        and(eq(channelMembers.channelId, channel.id), eq(channelMembers.oxyUserId, owner)),
      );

    // `canPublishToChannel` answers from this row alone — there is no "or the
    // owner" branch — so a channel that got one write and not the other is one
    // its own owner can never publish to and can never repair.
    expect(membership?.role).toBe('owner');
    expect(membership?.status).toBe('accepted');
    expect(membership?.respondedAt).toBeInstanceOf(Date);
    expect(channel.memberCount).toBe(1);
  });

  it('refuses a reserved handle and writes NOTHING', async () => {
    const owner = scope.user('reserved');

    await expect(
      insertChannelWithOwner('mine', owner, { title: 'A channel', signPosts: false }),
    ).rejects.toBeInstanceOf(ChannelHandleError);

    const rows = await getDb()
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.ownerOxyUserId, owner));
    expect(rows).toEqual([]);
  });

  it('refuses a handle the canonicalizer rejects for its SHAPE', async () => {
    await expect(
      insertChannelWithOwner('no spaces allowed', scope.user('shape'), {
        title: 'A channel',
        signPosts: false,
      }),
    ).rejects.toBeInstanceOf(ChannelHandleError);
  });

  it('refuses a second channel on a handle that differs only by case', async () => {
    const handle = uniqueHandle();
    const first = await insertChannelWithOwner(handle, scope.user('first'), {
      title: 'A channel',
      signPosts: false,
    });
    createdChannelIds.push(first.id);

    await expect(
      insertChannelWithOwner(handle.toUpperCase(), scope.user('second'), {
        title: 'Another channel',
        signPosts: false,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isUniqueViolation(error, 'channels_handle_lower_key'),
    );
  });
});

describe('updateChannelProfile', () => {
  it('moves handle_lower with handle', async () => {
    const channel = await insertChannelWithOwner(uniqueHandle(), scope.user('editor'), {
      title: 'A channel',
      signPosts: false,
    });
    createdChannelIds.push(channel.id);

    const renamed = uniqueHandle();
    await updateChannelProfile(channel.id, { handle: renamed.toUpperCase() });

    const stored = await readChannel(channel.id);
    expect(stored?.handle).toBe(renamed);
    expect(stored?.handleLower).toBe(renamed);
  });

  it('refuses an illegal handle rather than storing it', async () => {
    const channel = await insertChannelWithOwner(uniqueHandle(), scope.user('illegal'), {
      title: 'A channel',
      signPosts: false,
    });
    createdChannelIds.push(channel.id);

    await expect(updateChannelProfile(channel.id, { handle: 'me' })).rejects.toBeInstanceOf(
      ChannelHandleError,
    );

    const stored = await readChannel(channel.id);
    expect(stored?.handle).not.toBe('me');
  });

  it('answers null for a channel that does not exist', async () => {
    expect(await updateChannelProfile(randomUUID(), { title: 'x' })).toBeNull();
  });
});

/**
 * The defaults a Mongoose schema used to hold, now column DEFAULTs.
 *
 * Every case here inserts DIRECTLY rather than through the repository, and that
 * is the whole point: `insertChannelWithOwner` supplies `visibility`,
 * `signPosts` and `member_count` itself, so a fixture that goes through it can
 * never observe what the column would do on its own. The discriminating case is
 * the one where the field is ABSENT.
 */
describe('the defaults a caller may omit', () => {
  it('a channel is public, UNSIGNED, and starts on three zeroed counters', async () => {
    // `signPosts: false` is the one that matters: it means a channel post is
    // ANONYMOUS unless the owner says otherwise, so a default flipped the other
    // way would deanonymize every writer on every channel created after it.
    const handle = uniqueHandle();
    const [row] = await getDb()
      .insert(channels)
      .values({
        handle,
        handleLower: handle,
        title: 'Defaults',
        ownerOxyUserId: scope.user('defaults'),
      })
      .returning();
    createdChannelIds.push(row.id);

    expect(row.visibility).toBe('public');
    expect(row.signPosts).toBe(false);
    expect(row.followerCount).toBe(0);
    expect(row.memberCount).toBe(0);
    expect(row.postCount).toBe(0);
  });

  it('a membership row is a PENDING publisher — never an accepted one', async () => {
    const channel = await insertChannelWithOwner(uniqueHandle(), scope.user('host'), {
      title: 'A channel',
      signPosts: false,
    });
    createdChannelIds.push(channel.id);

    const [row] = await getDb()
      .insert(channelMembers)
      .values({ channelId: channel.id, oxyUserId: scope.user('invitee') })
      .returning();

    expect(row.role).toBe('publisher');
    expect(row.status).toBe('pending');
  });

  it('a follow notifies by default — following a channel IS subscribing to it', async () => {
    const channel = await insertChannelWithOwner(uniqueHandle(), scope.user('broadcaster'), {
      title: 'A channel',
      signPosts: false,
    });
    createdChannelIds.push(channel.id);

    const [row] = await getDb()
      .insert(channelFollows)
      .values({ channelId: channel.id, oxyUserId: scope.user('subscriber') })
      .returning();

    expect(row.notify).toBe(true);
  });

  it('a lane is `mixed` — a new lane behaves like no lane at all', async () => {
    const name = `lane-${randomUUID().slice(0, 8)}`;
    const [row] = await getDb()
      .insert(lanes)
      .values({
        ownerType: 'user',
        ownerId: scope.user('lane-defaults'),
        name,
        nameLower: name,
      })
      .returning();
    createdLaneIds.push(row.id);

    expect(row.displayMode).toBe('mixed');
  });
});

describe('deleteChannelCascade', () => {
  it('releases the channel\'s posts rather than deleting them', async () => {
    const owner = scope.user('deleter');
    const channel = await insertChannelWithOwner(uniqueHandle(), owner, {
      title: 'A channel',
      signPosts: false,
    });
    createdChannelIds.push(channel.id);
    const lane = await insertLane({
      ownerType: 'channel',
      ownerId: channel.id,
      name: 'Channel lane',
      displayMode: 'tab',
    });
    createdLaneIds.push(lane.id);
    const post = await seedPost(scope, { channelId: channel.id, laneId: lane.id });

    await deleteChannelCascade(channel.id);

    // EXISTS first, and only then its columns — the failure worth guarding
    // against is the row being GONE, against which an assertion on
    // `row?.channelId` reads `undefined` and passes.
    const released = await readPostRow(post.id);
    expect(released).toBeDefined();
    expect(released?.channelId).toBeNull();
    expect(released?.laneId).toBeNull();
  });

  it('takes the channel\'s lanes, their mutes, its members and its followers', async () => {
    const owner = scope.user('cascade');
    const channel = await insertChannelWithOwner(uniqueHandle(), owner, {
      title: 'A channel',
      signPosts: false,
    });
    createdChannelIds.push(channel.id);
    const lane = await insertLane({
      ownerType: 'channel',
      ownerId: channel.id,
      name: 'Doomed lane',
      displayMode: 'tab',
    });
    createdLaneIds.push(lane.id);

    const db = getDb();
    await db.insert(laneMutes).values({
      viewerOxyUserId: scope.user('reader'),
      laneId: lane.id,
      laneOwnerOxyUserId: owner,
    });
    await db.insert(channelFollows).values({
      oxyUserId: scope.user('follower'),
      channelId: channel.id,
    });

    await deleteChannelCascade(channel.id);

    expect(await readChannel(channel.id)).toBeUndefined();
    expect(await readLane(lane.id)).toBeUndefined();
    expect(
      await db.select({ id: laneMutes.id }).from(laneMutes).where(eq(laneMutes.laneId, lane.id)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: channelMembers.id })
        .from(channelMembers)
        .where(eq(channelMembers.channelId, channel.id)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: channelFollows.id })
        .from(channelFollows)
        .where(eq(channelFollows.channelId, channel.id)),
    ).toEqual([]);
  });

  it('leaves another channel\'s posts and lanes untouched', async () => {
    const doomed = await insertChannelWithOwner(uniqueHandle(), scope.user('doomed'), {
      title: 'Doomed',
      signPosts: false,
    });
    createdChannelIds.push(doomed.id);
    const survivor = await insertChannelWithOwner(uniqueHandle(), scope.user('survivor'), {
      title: 'Survivor',
      signPosts: false,
    });
    createdChannelIds.push(survivor.id);
    const survivingLane = await insertLane({
      ownerType: 'channel',
      ownerId: survivor.id,
      name: 'Kept lane',
      displayMode: 'tab',
    });
    createdLaneIds.push(survivingLane.id);
    const kept = await seedPost(scope, { channelId: survivor.id, laneId: survivingLane.id });

    await deleteChannelCascade(doomed.id);

    const stillThere = await readPostRow(kept.id);
    expect(stillThere?.channelId).toBe(survivor.id);
    expect(stillThere?.laneId).toBe(survivingLane.id);
    expect(await readLane(survivingLane.id)).toBeDefined();
  });

  it('is re-runnable — a channel already gone is not an error', async () => {
    const channel = await insertChannelWithOwner(uniqueHandle(), scope.user('twice'), {
      title: 'A channel',
      signPosts: false,
    });
    createdChannelIds.push(channel.id);

    await deleteChannelCascade(channel.id);
    await expect(deleteChannelCascade(channel.id)).resolves.toBeUndefined();
  });
});

/**
 * The FOREIGN KEY on its own, with no application code between it and the row.
 *
 * `deleteChannelCascade` is not the only way a `channels` row can go: a
 * destructive background sweep deletes across many tables directly, and this is
 * the shape it takes. Migration `0012` flipped `posts.channel_id` from
 * `ON DELETE CASCADE` to `ON DELETE SET NULL` precisely because "correct
 * because the application always releases first" is a property of ONE call
 * site.
 *
 * These cases delete the row with a bare `db.delete(channels)`, which is the
 * only way to observe the constraint rather than the repository. **After `0012`
 * no test can distinguish the release inside `deleteChannelCascade` from the FK
 * by its OUTCOME** — both leave `channel_id` null — and the second case below
 * is the honest statement of what the repository still does that the constraint
 * does not.
 */
describe('deleting a channel ROW directly, bypassing the repository', () => {
  it('leaves its posts alive with a null channel_id — this is migration 0012', async () => {
    const channel = await insertChannelWithOwner(uniqueHandle(), scope.user('direct'), {
      title: 'A channel',
      signPosts: false,
    });
    createdChannelIds.push(channel.id);
    const post = await seedPost(scope, { channelId: channel.id });

    await getDb().delete(channels).where(eq(channels.id, channel.id));

    // Under the old `ON DELETE CASCADE` this row was GONE — one channel delete
    // destroying every post ever published to it, other publishers' included.
    const survivor = await readPostRow(post.id);
    expect(survivor).toBeDefined();
    expect(survivor?.channelId).toBeNull();
  });

  it('DOES leave the channel\'s lanes orphaned — which is why the repository stays', async () => {
    // `lanes.owner_id` is POLYMORPHIC (an Oxy account id or a channel id,
    // discriminated by `owner_type`), so it carries no foreign key and no
    // cascade can reach it. A direct delete therefore leaves lanes naming a
    // channel that no longer exists: they still list from
    // `GET /lanes?ownerType=channel&ownerId=…`, `laneSource` finds no channel
    // and serves nothing, and `callerManagesLane` finds no channel and answers
    // 404 — so nobody can delete them either.
    //
    // This is the difference the FK cannot cover, and it is the reason
    // `deleteChannelCascade` remains the door rather than a redundant wrapper.
    const channel = await insertChannelWithOwner(uniqueHandle(), scope.user('orphaner'), {
      title: 'A channel',
      signPosts: false,
    });
    createdChannelIds.push(channel.id);
    const lane = await insertLane({
      ownerType: 'channel',
      ownerId: channel.id,
      name: 'Orphan',
      displayMode: 'tab',
    });
    createdLaneIds.push(lane.id);

    await getDb().delete(channels).where(eq(channels.id, channel.id));

    expect(await readLane(lane.id)).toBeDefined();
    expect((await readLane(lane.id))?.ownerId).toBe(channel.id);
  });
});

describe('deleting a LANE', () => {
  it('releases its posts and drops its mutes, by foreign key alone', async () => {
    const owner = scope.user('lane-deleter');
    const lane = await insertLane({
      ownerType: 'user',
      ownerId: owner,
      name: 'Doomed',
      displayMode: 'tab',
    });
    const post = await seedPost(scope, { oxyUserId: owner, laneId: lane.id });
    const db = getDb();
    await db.insert(laneMutes).values({
      viewerOxyUserId: scope.user('lane-reader'),
      laneId: lane.id,
      laneOwnerOxyUserId: owner,
    });

    // The route issues exactly this one statement. `posts.lane_id` is
    // `ON DELETE SET NULL` and `lane_mutes.lane_id` is `ON DELETE CASCADE`, so
    // the three writes the Mongo handler sequenced by hand are now atomic and
    // have no order left to get wrong.
    await db.delete(lanes).where(eq(lanes.id, lane.id));

    const released = await readPostRow(post.id);
    expect(released).toBeDefined();
    expect(released?.laneId).toBeNull();
    expect(
      await db.select({ id: laneMutes.id }).from(laneMutes).where(eq(laneMutes.laneId, lane.id)),
    ).toEqual([]);
  });

  it('releases a post written by a DIFFERENT publisher than the lane\'s owner', async () => {
    // Mongo scoped its `updateMany` to the lane's publisher, so a post carrying
    // the lane but written by somebody else kept a dangling `laneId`. The
    // foreign key is unscoped, which is what the invariant actually says.
    const lane = await insertLane({
      ownerType: 'user',
      ownerId: scope.user('lane-owner'),
      name: 'Cross',
      displayMode: 'tab',
    });
    const stray = await seedPost(scope, { oxyUserId: scope.user('stranger'), laneId: lane.id });

    await getDb().delete(lanes).where(eq(lanes.id, lane.id));

    const released = await readPostRow(stray.id);
    expect(released).toBeDefined();
    expect(released?.laneId).toBeNull();
  });
});
