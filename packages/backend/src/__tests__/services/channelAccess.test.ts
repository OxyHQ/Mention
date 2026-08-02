import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * The ONE definition of what somebody may do with a channel.
 *
 * The three questions are deliberately separate and are asserted separately,
 * because collapsing them is the mistake that matters: a publisher who could
 * manage the channel would be able to rewrite its membership, and an "or the
 * owner" shortcut in `canPublishToChannel` would be a second answer to a question
 * the owner's own `ChannelMember` row already answers.
 */

const channelFindById = vi.fn();
vi.mock('../../models/Channel', () => ({
  Channel: {
    findById: (...args: unknown[]) => channelFindById(...args),
    updateOne: (...args: unknown[]) => channelUpdateOne(...args),
  },
}));

const channelUpdateOne = vi.fn();

const memberExists = vi.fn();
vi.mock('../../models/ChannelMember', () => ({
  ChannelMember: { exists: (...args: unknown[]) => memberExists(...args) },
}));

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

const CHANNEL_ID = new mongoose.Types.ObjectId().toString();
const OWNER_ID = 'owner-1';
const PUBLISHER_ID = 'publisher-1';
const STRANGER_ID = 'stranger-1';

beforeEach(() => {
  channelFindById.mockReset();
  channelUpdateOne.mockReset();
  memberExists.mockReset();
  loggerWarn.mockReset();
  channelUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  memberExists.mockResolvedValue(null);
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
    const channel = { ownerOxyUserId: OWNER_ID };
    expect(canManageChannel(channel, OWNER_ID)).toBe(true);
    expect(canManageChannel(channel, PUBLISHER_ID)).toBe(false);
    expect(canManageChannel(channel, undefined)).toBe(false);
  });
});

describe('canPublishToChannel', () => {
  it('is an ACCEPTED membership row and nothing else', async () => {
    memberExists.mockResolvedValue({ _id: 'm1' });
    expect(await canPublishToChannel(CHANNEL_ID, PUBLISHER_ID)).toBe(true);
    expect(memberExists).toHaveBeenCalledWith({
      channelId: CHANNEL_ID,
      oxyUserId: PUBLISHER_ID,
      status: 'accepted',
    });
  });

  it('answers false for a non-member without inventing an owner shortcut', async () => {
    memberExists.mockResolvedValue(null);
    expect(await canPublishToChannel(CHANNEL_ID, STRANGER_ID)).toBe(false);
  });

  it('answers false without a query for a missing user or a malformed channel id', async () => {
    expect(await canPublishToChannel(CHANNEL_ID, undefined)).toBe(false);
    expect(await canPublishToChannel('not-an-id', PUBLISHER_ID)).toBe(false);
    expect(memberExists).not.toHaveBeenCalled();
  });
});

describe('assertCanPublishToChannel', () => {
  it('resolves to null WITHOUT a query when there is no channel', async () => {
    await expect(assertCanPublishToChannel(null, OWNER_ID)).resolves.toBeNull();
    await expect(assertCanPublishToChannel(undefined, OWNER_ID)).resolves.toBeNull();
    expect(channelFindById).not.toHaveBeenCalled();
    expect(memberExists).not.toHaveBeenCalled();
  });

  it('404s an unknown or malformed channel — no existence oracle', async () => {
    // A malformed id and a real channel belonging to somebody else must be
    // indistinguishable, or this endpoint tells a caller which ids are real.
    await expect(assertCanPublishToChannel('not-an-id', OWNER_ID)).rejects.toMatchObject({
      status: 404,
    });
    channelFindById.mockResolvedValue(null);
    await expect(assertCanPublishToChannel(CHANNEL_ID, OWNER_ID)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('403s a real channel the author may not publish to', async () => {
    // A 403 rather than a 404 on purpose: the channel is public, so its existence
    // is not a secret, and an invited-but-not-yet-accepted member needs to be able
    // to tell "not a member" from "no such channel".
    channelFindById.mockResolvedValue({ _id: CHANNEL_ID, ownerOxyUserId: OWNER_ID });
    memberExists.mockResolvedValue(null);
    const error = await assertCanPublishToChannel(CHANNEL_ID, STRANGER_ID).catch((e) => e);
    expect(error).toBeInstanceOf(ChannelAccessError);
    expect(error).toMatchObject({ status: 403 });
  });

  it('403s an anonymous author before touching the database', async () => {
    await expect(assertCanPublishToChannel(CHANNEL_ID, null)).rejects.toMatchObject({ status: 403 });
    expect(channelFindById).not.toHaveBeenCalled();
  });

  it('returns the channel for an accepted member', async () => {
    const channel = { _id: CHANNEL_ID, ownerOxyUserId: OWNER_ID };
    channelFindById.mockResolvedValue(channel);
    memberExists.mockResolvedValue({ _id: 'm1' });
    await expect(assertCanPublishToChannel(CHANNEL_ID, PUBLISHER_ID)).resolves.toBe(channel);
  });
});

describe('bumpChannelCounter', () => {
  it('increments the named field', async () => {
    await bumpChannelCounter(CHANNEL_ID, 'followerCount', 1);
    expect(channelUpdateOne).toHaveBeenCalledWith(
      { _id: CHANNEL_ID },
      { $inc: { followerCount: 1 } },
    );
  });

  it('is a no-op for a zero delta or a malformed id', async () => {
    await bumpChannelCounter(CHANNEL_ID, 'postCount', 0);
    await bumpChannelCounter('not-an-id', 'postCount', 1);
    await bumpChannelCounter('', 'postCount', 1);
    expect(channelUpdateOne).not.toHaveBeenCalled();
  });

  it('swallows a write failure and logs it — a counter must never fail a publish', async () => {
    channelUpdateOne.mockRejectedValue(new Error('mongo down'));
    await expect(bumpChannelCounter(CHANNEL_ID, 'postCount', 1)).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalled();
  });
});
