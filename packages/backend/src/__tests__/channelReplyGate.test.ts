import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A channel's post takes NO replies — the predicates themselves, and the shape of
 * the refusal.
 *
 * The rule is keyed on the post's AUTHOR: a channel is an Oxy account and authors
 * its own posts, so "is this a channel post" is "is this author a channel
 * account". Each answer is paired with its opposite, because a gate that cannot
 * distinguish success from failure is worse than no gate: every "refuses a
 * channel parent" case sits beside a control that a plain post still accepts
 * replies exactly as before.
 *
 * ## Why the id lookup reads a database instead of mocking `findById`
 *
 * The gate's whole history is a guard that LOOKED present and was inert. It read
 * `ObjectId.isValid(parentPostId)` before its lookup, and on this branch
 * `posts.id` is `text` holding uuid v7 — so for every post minted since the
 * cutover it answered `false`, which the callers read as "not a channel post"
 * and let the reply THROUGH. A mocked `findById` cannot see that: the mock
 * answers whatever it was told, and the id-shape check that decided whether the
 * lookup happened at all never runs against a real id. So the fixtures here are
 * rows, and the ids are the ones the database actually mints.
 *
 * The one thing that is NOT a row is the account KIND, because Oxy owns it and
 * Postgres cannot see it. `resolveUserSummaries` — the identity batch
 * `publishAsAccount` resolves kinds through — is the seam, mocked rather than
 * `isChannelAccount` itself, so the fail-soft direction the gate depends on (an
 * unresolvable author is NOT a channel) is exercised through the real code.
 */

const resolveUserSummaries = vi.fn();
vi.mock('../services/PostHydrationService', () => ({
  resolveUserSummaries: (...args: unknown[]) => resolveUserSummaries(...args),
}));

import { closePostgres, connectPostgres } from '../db/postgres';
import { clearPostScope, postScope, seedPost } from './helpers/postFixtures';
import {
  ChannelReplyError,
  assertParentAcceptsReplies,
  parentIsChannelPost,
  postIsAuthoredByChannel,
} from '../utils/channelReplyGate';

const scope = postScope('channel-reply-gate');
const CHANNEL_ACCOUNT = scope.user('channel');
const PERSON = scope.user('person');

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  resolveUserSummaries.mockReset();
  resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const map = new Map<string, { user: { id: string; kind?: string } }>();
    for (const id of ids) {
      map.set(id, { user: { id, kind: id === CHANNEL_ACCOUNT ? 'channel' : 'personal' } });
    }
    return map;
  });
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
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
  it('answers false for no id at all', async () => {
    expect(await parentIsChannelPost(undefined)).toBe(false);
    expect(await parentIsChannelPost('')).toBe(false);
  });

  it('answers true for a parent a channel account wrote', async () => {
    const parent = await seedPost(scope, { oxyUserId: CHANNEL_ACCOUNT });
    expect(await parentIsChannelPost(parent.id)).toBe(true);
  });

  it('answers false for a parent a person wrote, and for one that is gone', async () => {
    const plain = await seedPost(scope, { oxyUserId: PERSON });
    expect(await parentIsChannelPost(plain.id)).toBe(false);
    // An id that names no row. This is also the case that used to be answered by
    // an id-SHAPE guard: a `text` id matching nothing already returns nothing,
    // which is why the guard was removed rather than widened.
    expect(await parentIsChannelPost('channel-reply-gate-no-such-post')).toBe(false);
  });

  it('answers TRUE for a real uuid v7 id — the shape the removed guard rejected', async () => {
    // The regression case, stated as its own. `insertPostRecord` mints uuid v7,
    // and `ObjectId.isValid` answers `false` for one — so this exact fixture is
    // what the old gate returned `false` for while looking correct, and `false`
    // here means the reply is allowed through.
    const parent = await seedPost(scope, { oxyUserId: CHANNEL_ACCOUNT });
    expect(parent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(await parentIsChannelPost(parent.id)).toBe(true);
  });
});

describe('assertParentAcceptsReplies', () => {
  it('throws a 403 ChannelReplyError for a channel-authored parent', async () => {
    const parent = await seedPost(scope, { oxyUserId: CHANNEL_ACCOUNT });
    await expect(assertParentAcceptsReplies(parent.id)).rejects.toBeInstanceOf(ChannelReplyError);
    await expect(assertParentAcceptsReplies(parent.id)).rejects.toMatchObject({ status: 403 });
  });

  it('resolves for an ordinary parent', async () => {
    const plain = await seedPost(scope, { oxyUserId: PERSON });
    await expect(assertParentAcceptsReplies(plain.id)).resolves.toBeUndefined();
  });
});
