import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * A channel's post takes NO replies — the predicates themselves, and the shape of
 * the refusal.
 *
 * The rule is keyed on the post's AUTHOR: a channel is an Oxy account and authors
 * its own posts, so "is this a channel post" is "is this author a channel
 * account". Each case is paired with a control that a plain post still accepts
 * replies exactly as before, because a gate that cannot distinguish success from
 * failure is worse than no gate.
 */

const postFindById = vi.fn();
vi.mock('../models/Post', () => ({
  Post: {
    findById: (...args: unknown[]) => postFindById(...args),
  },
}));

const resolveUserSummaries = vi.fn();
vi.mock('../services/PostHydrationService', () => ({
  resolveUserSummaries: (...args: unknown[]) => resolveUserSummaries(...args),
}));

import {
  ChannelReplyError,
  assertParentAcceptsReplies,
  parentIsChannelPost,
  postIsAuthoredByChannel,
} from '../utils/channelReplyGate';

const PARENT_ID = new mongoose.Types.ObjectId().toString();
const CHANNEL_ACCOUNT = 'oxy-channel-account';
const PERSON = 'oxy-person';

/** A chainable stand-in for `Post.findById(...).select(...).lean()`. */
function projection<T>(value: T) {
  const link = { select: () => link, lean: () => Promise.resolve(value) };
  return link;
}

beforeEach(() => {
  postFindById.mockReset();
  postFindById.mockReturnValue(projection(null));
  resolveUserSummaries.mockReset();
  resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const map = new Map<string, { user: { id: string; kind?: string } }>();
    for (const id of ids) {
      map.set(id, { user: { id, kind: id === CHANNEL_ACCOUNT ? 'channel' : 'personal' } });
    }
    return map;
  });
});

describe('postIsAuthoredByChannel', () => {
  it('is true when the author is a channel account', async () => {
    expect(await postIsAuthoredByChannel({ oxyUserId: CHANNEL_ACCOUNT })).toBe(true);
  });

  it.each([
    ['a person', { oxyUserId: PERSON }],
    ['an absent author', {}],
    ['an explicit null author', { oxyUserId: null }],
    ['a null post', null],
    ['an undefined post', undefined],
  ])('is false for %s', async (_label, input) => {
    expect(await postIsAuthoredByChannel(input as { oxyUserId?: string | null } | null)).toBe(false);
  });

  it('answers false — never true — when the author will not resolve', async () => {
    // The direction is deliberate and asymmetric: answering "channel" on an
    // unresolvable author would refuse replies to EVERY post on the site for the
    // duration of an Oxy outage. See the module docstring.
    resolveUserSummaries.mockRejectedValue(new Error('oxy down'));
    expect(await postIsAuthoredByChannel({ oxyUserId: CHANNEL_ACCOUNT })).toBe(false);
  });

  it('answers false for an author Oxy returned without a kind', async () => {
    // An Oxy build that does not emit the field, or a degraded summary — unknown
    // reads as not-a-channel, for the same asymmetry as the outage case above.
    resolveUserSummaries.mockResolvedValue(
      new Map([[CHANNEL_ACCOUNT, { user: { id: CHANNEL_ACCOUNT } }]]),
    );
    expect(await postIsAuthoredByChannel({ oxyUserId: CHANNEL_ACCOUNT })).toBe(false);
  });
});

describe('parentIsChannelPost', () => {
  it('answers false without a query when the id is missing or malformed', async () => {
    expect(await parentIsChannelPost(undefined)).toBe(false);
    expect(await parentIsChannelPost('')).toBe(false);
    expect(await parentIsChannelPost('not-an-object-id')).toBe(false);
    expect(postFindById).not.toHaveBeenCalled();
  });

  it('answers true for a parent a channel account wrote', async () => {
    postFindById.mockReturnValue(projection({ oxyUserId: CHANNEL_ACCOUNT }));
    expect(await parentIsChannelPost(PARENT_ID)).toBe(true);
  });

  it('answers false for a parent a person wrote, and for one that is gone', async () => {
    postFindById.mockReturnValue(projection({ oxyUserId: PERSON }));
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
  it('throws a 403 ChannelReplyError for a channel-authored parent', async () => {
    postFindById.mockReturnValue(projection({ oxyUserId: CHANNEL_ACCOUNT }));
    await expect(assertParentAcceptsReplies(PARENT_ID)).rejects.toBeInstanceOf(ChannelReplyError);
    await expect(assertParentAcceptsReplies(PARENT_ID)).rejects.toMatchObject({ status: 403 });
  });

  it('resolves for an ordinary parent', async () => {
    postFindById.mockReturnValue(projection({ oxyUserId: PERSON }));
    await expect(assertParentAcceptsReplies(PARENT_ID)).resolves.toBeUndefined();
  });
});
