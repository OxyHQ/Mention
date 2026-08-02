import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * A channel post takes NO replies — the predicate itself, and every one of the
 * FOUR paths that can create a reply.
 *
 * Each site is tested with BOTH answers, because a gate that cannot distinguish
 * success from failure is worse than no gate: every "refuses a channel parent"
 * case is paired with a control that a plain post, and a post carrying a `laneId`,
 * still accept replies exactly as before.
 *
 * The two federated sites additionally assert the SHAPE of the refusal, which is
 * the part that matters most there: a drop, never a throw and never a 4xx. A
 * throw fails the BullMQ inbox job into permanent retry, and a 4xx makes Mastodon
 * stop delivering to this instance entirely.
 */

const postFindById = vi.fn();
vi.mock('../models/Post', () => ({
  Post: {
    findById: (...args: unknown[]) => postFindById(...args),
  },
}));

import {
  ChannelReplyError,
  assertParentAcceptsReplies,
  isChannelPost,
  parentIsChannelPost,
} from '../utils/channelReplyGate';

const PARENT_ID = new mongoose.Types.ObjectId().toString();
const CHANNEL_ID = new mongoose.Types.ObjectId().toString();
const LANE_ID = new mongoose.Types.ObjectId().toString();

/** A chainable stand-in for `Post.findById(...).select(...).lean()`. */
function projection<T>(value: T) {
  const link = { select: () => link, lean: () => Promise.resolve(value) };
  return link;
}

beforeEach(() => {
  postFindById.mockReset();
  postFindById.mockReturnValue(projection(null));
});

describe('isChannelPost — the ONE predicate', () => {
  it('is true only for a non-empty string channelId', () => {
    expect(isChannelPost({ channelId: CHANNEL_ID })).toBe(true);
  });

  it.each([
    ['undefined field', {}],
    ['an explicit null', { channelId: null }],
    ['an empty string', { channelId: '' }],
    ['a null post', null],
    ['an undefined post', undefined],
  ])('is false for %s', (_label, input) => {
    expect(isChannelPost(input as { channelId?: unknown } | null | undefined)).toBe(false);
  });

  it('is false for a post that carries only a lane — a lane is a lens, not a destination', () => {
    expect(isChannelPost({ laneId: LANE_ID } as { channelId?: unknown })).toBe(false);
  });
});

describe('parentIsChannelPost', () => {
  it('answers false without a query when the id is missing or malformed', async () => {
    expect(await parentIsChannelPost(undefined)).toBe(false);
    expect(await parentIsChannelPost('')).toBe(false);
    expect(await parentIsChannelPost('not-an-object-id')).toBe(false);
    expect(postFindById).not.toHaveBeenCalled();
  });

  it('answers true for a parent that belongs to a channel', async () => {
    postFindById.mockReturnValue(projection({ channelId: CHANNEL_ID }));
    expect(await parentIsChannelPost(PARENT_ID)).toBe(true);
  });

  it('answers false for a parent that does not, and for one that is gone', async () => {
    postFindById.mockReturnValue(projection({ channelId: undefined }));
    expect(await parentIsChannelPost(PARENT_ID)).toBe(false);
    postFindById.mockReturnValue(projection(null));
    expect(await parentIsChannelPost(PARENT_ID)).toBe(false);
  });

  it('lets a database error propagate rather than answering "not a channel"', async () => {
    // Fail LOUD: on the HTTP paths this becomes a 500 and on the BullMQ path it
    // retries. Swallowing it into `false` would open the gate during an outage.
    postFindById.mockImplementation(() => {
      throw new Error('mongo down');
    });
    await expect(parentIsChannelPost(PARENT_ID)).rejects.toThrow('mongo down');
  });
});

describe('assertParentAcceptsReplies', () => {
  it('throws a 403 ChannelReplyError for a channel parent', async () => {
    postFindById.mockReturnValue(projection({ channelId: CHANNEL_ID }));
    await expect(assertParentAcceptsReplies(PARENT_ID)).rejects.toBeInstanceOf(ChannelReplyError);
    await expect(assertParentAcceptsReplies(PARENT_ID)).rejects.toMatchObject({ status: 403 });
  });

  it('resolves for an ordinary parent, and for one that carries a lane', async () => {
    postFindById.mockReturnValue(projection({ channelId: undefined, laneId: LANE_ID }));
    await expect(assertParentAcceptsReplies(PARENT_ID)).resolves.toBeUndefined();
  });
});
