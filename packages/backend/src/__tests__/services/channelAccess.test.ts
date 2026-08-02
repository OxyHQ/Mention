import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ONE definition of what somebody may do with a channel.
 *
 * The three questions are deliberately separate and are asserted separately,
 * because collapsing them is the mistake that matters: a publisher who could
 * manage the channel would be able to rewrite its membership, and an "or the
 * owner" shortcut in `canPublishToChannel` would be a second answer to a question
 * the owner's own `channel_members` row already answers.
 *
 * ## Rows, because the guard that broke this was invisible to a mock
 *
 * `canPublishToChannel` and `assertCanPublishToChannel` both short-circuited on
 * `ObjectId.isValid(channelId)`. After the cutover `channels.id` is `text`
 * holding uuid v7, so both answered for EVERY real channel as though it were
 * malformed — a `false` and a 404 respectively, which refused every publish. It
 * failed toward refusal rather than toward exposure, which is why the symptom was
 * "nobody can post to a channel" rather than "anybody can". A mocked
 * `ChannelMember.exists` reports whether it was CALLED, with the id never
 * reaching the check that was wrong; the case that asserted "no query for a
 * malformed id" would have gone on passing throughout.
 */

import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import * as postgres from '../../db/postgres';
import { channelMembers, channels } from '../../db/schema/channels';

const loggerWarn = vi.fn();
vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: (...a: unknown[]) => loggerWarn(...a), error: vi.fn() },
}));

import {
  ChannelAccessError,
  assertCanPublishToChannel,
  bumpChannelCounter,
  canManageChannel,
  canPublishToChannel,
  canViewChannel,
} from '../../services/channelAccess';

const OWNER_ID = 'chanaccess-owner';
const PUBLISHER_ID = 'chanaccess-publisher';
const STRANGER_ID = 'chanaccess-stranger';
const seeded: string[] = [];
let seq = 0;

/** One public channel owned by `OWNER_ID`. Returns its id. */
async function channel(): Promise<string> {
  const handle = `chanaccess-${seq++}`;
  const [row] = await getDb()
    .insert(channels)
    .values({ handle, handleLower: handle, title: 'a channel', ownerOxyUserId: OWNER_ID })
    .returning({ id: channels.id });
  seeded.push(row.id);
  return row.id;
}

/** A membership row in `status`. */
async function member(
  channelId: string,
  oxyUserId: string,
  status: 'pending' | 'accepted' | 'declined' | 'removed',
): Promise<void> {
  await getDb()
    .insert(channelMembers)
    .values({ channelId, oxyUserId, role: 'publisher', status });
}

/** The stored counter, for asserting a bump landed. */
async function counters(channelId: string) {
  const [row] = await getDb()
    .select({
      followerCount: channels.followerCount,
      memberCount: channels.memberCount,
      postCount: channels.postCount,
    })
    .from(channels)
    .where(eq(channels.id, channelId));
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  loggerWarn.mockReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  const ids = seeded.splice(0);
  // `channel_members` goes with its channel by `ON DELETE CASCADE`.
  if (ids.length > 0) await getDb().delete(channels).where(inArray(channels.id, ids));
});

afterAll(async () => {
  await closePostgres();
});

describe('canViewChannel', () => {
  it('lets anybody — including an anonymous reader — see a public channel', () => {
    expect(canViewChannel({ visibility: 'public' })).toBe(true);
    expect(canViewChannel({ visibility: 'public' }, STRANGER_ID)).toBe(true);
  });

  it('refuses any other visibility, so a future restricted level fails CLOSED', () => {
    // The whole reason this function exists in v1 is that a level added later must
    // be a branch HERE and nowhere else. An unrecognised value must not be served.
    expect(canViewChannel({ visibility: 'restricted' }, OWNER_ID)).toBe(false);
  });
});

describe('canManageChannel', () => {
  it('is the owner and nobody else', () => {
    const subject = { ownerOxyUserId: OWNER_ID };
    expect(canManageChannel(subject, OWNER_ID)).toBe(true);
    expect(canManageChannel(subject, PUBLISHER_ID)).toBe(false);
    expect(canManageChannel(subject, undefined)).toBe(false);
  });
});

describe('canPublishToChannel', () => {
  it('is an ACCEPTED membership row and nothing else', async () => {
    const channelId = await channel();
    await member(channelId, PUBLISHER_ID, 'accepted');

    expect(await canPublishToChannel(channelId, PUBLISHER_ID)).toBe(true);
  });

  it.each(['pending', 'declined', 'removed'] as const)(
    'answers false for a %s membership — a row is not consent',
    async (status) => {
      const channelId = await channel();
      await member(channelId, PUBLISHER_ID, status);

      expect(await canPublishToChannel(channelId, PUBLISHER_ID)).toBe(false);
    },
  );

  it('answers false for a non-member without inventing an owner shortcut', async () => {
    const channelId = await channel();
    // The OWNER, with no membership row. The owner's founding row is written when
    // the channel is created, and this function answers from that row alone — an
    // "or the owner" branch here would be a second answer that can drift from it.
    expect(await canPublishToChannel(channelId, OWNER_ID)).toBe(false);
    expect(await canPublishToChannel(channelId, STRANGER_ID)).toBe(false);
  });

  it('answers TRUE for a real uuid v7 channel id — the shape the removed guard rejected', async () => {
    const channelId = await channel();
    await member(channelId, PUBLISHER_ID, 'accepted');

    expect(channelId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(await canPublishToChannel(channelId, PUBLISHER_ID)).toBe(true);
  });

  it('answers false for a missing user or an id that names no channel', async () => {
    const channelId = await channel();
    expect(await canPublishToChannel(channelId, undefined)).toBe(false);
    expect(await canPublishToChannel('chanaccess-no-such-channel', PUBLISHER_ID)).toBe(false);
  });
});

describe('assertCanPublishToChannel', () => {
  it('resolves to null when there is no channel', async () => {
    await expect(assertCanPublishToChannel(null, OWNER_ID)).resolves.toBeNull();
    await expect(assertCanPublishToChannel(undefined, OWNER_ID)).resolves.toBeNull();
  });

  it('404s an id that names no channel — no existence oracle', async () => {
    // An unknown id and a real channel belonging to somebody else must be
    // indistinguishable, or this endpoint tells a caller which ids are real.
    await expect(
      assertCanPublishToChannel('chanaccess-no-such-channel', OWNER_ID),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('403s a real channel the author may not publish to', async () => {
    // A 403 rather than a 404 on purpose: the channel is public, so its existence
    // is not a secret, and an invited-but-not-yet-accepted member needs to be able
    // to tell "not a member" from "no such channel".
    const channelId = await channel();
    const error = await assertCanPublishToChannel(channelId, STRANGER_ID).catch((e) => e);
    expect(error).toBeInstanceOf(ChannelAccessError);
    expect(error).toMatchObject({ status: 403 });
  });

  it('403s an anonymous author', async () => {
    const channelId = await channel();
    await expect(assertCanPublishToChannel(channelId, null)).rejects.toMatchObject({ status: 403 });
  });

  it('returns the channel for an accepted member', async () => {
    const channelId = await channel();
    await member(channelId, PUBLISHER_ID, 'accepted');

    const resolved = await assertCanPublishToChannel(channelId, PUBLISHER_ID);
    expect(resolved).toMatchObject({ id: channelId, ownerOxyUserId: OWNER_ID });
  });
});

describe('bumpChannelCounter', () => {
  it('increments the named field and leaves the others alone', async () => {
    const channelId = await channel();

    await bumpChannelCounter(channelId, 'followerCount', 1);

    expect(await counters(channelId)).toEqual({
      followerCount: 1,
      memberCount: 0,
      postCount: 0,
    });
  });

  it('decrements too, and two bumps add up', async () => {
    const channelId = await channel();

    await bumpChannelCounter(channelId, 'memberCount', 1);
    await bumpChannelCounter(channelId, 'memberCount', 1);
    await bumpChannelCounter(channelId, 'memberCount', -1);

    expect((await counters(channelId))?.memberCount).toBe(1);
  });

  it('is a no-op for a zero delta or an id that names no channel', async () => {
    const channelId = await channel();

    await bumpChannelCounter(channelId, 'postCount', 0);
    await bumpChannelCounter('chanaccess-no-such-channel', 'postCount', 1);
    await bumpChannelCounter('', 'postCount', 1);

    expect((await counters(channelId))?.postCount).toBe(0);
  });

  it('swallows a write failure and logs it — a counter must never fail a publish', async () => {
    const channelId = await channel();
    vi.spyOn(postgres, 'getDb').mockImplementation(() => {
      throw new Error('postgres down');
    });

    await expect(bumpChannelCounter(channelId, 'postCount', 1)).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalled();
  });

  it('cannot drive a counter negative — the CHECK refuses it, and the throw is swallowed', async () => {
    // Mongo's `$inc` could take a counter below zero on a decrement race and
    // nothing would notice. Here the table refuses the write; the helper is still
    // best-effort, so the refusal costs the counter rather than the publish.
    const channelId = await channel();

    await expect(bumpChannelCounter(channelId, 'postCount', -1)).resolves.toBeUndefined();

    expect((await counters(channelId))?.postCount).toBe(0);
    expect(loggerWarn).toHaveBeenCalled();
  });
});
