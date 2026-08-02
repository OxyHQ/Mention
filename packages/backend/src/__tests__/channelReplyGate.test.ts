import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * A channel post takes NO replies — the predicate itself, against real rows.
 *
 * Each answer is paired with its opposite, because a gate that cannot
 * distinguish success from failure is worse than no gate: every "refuses a
 * channel parent" case sits beside a control that a plain post, and a post
 * carrying a `laneId`, still accept replies exactly as before.
 *
 * ## Why this suite reads a database instead of mocking `findById`
 *
 * The gate's whole history is a guard that LOOKED present and was inert. It read
 * `ObjectId.isValid(parentPostId)` before its lookup, and on this branch
 * `posts.id` is `text` holding uuid v7 — so for every post minted since the
 * cutover it answered `false`, which the callers read as "not a channel post"
 * and let the reply THROUGH. A mocked `findById` cannot see that: the mock
 * answers whatever it was told, and the id-shape check that decided whether the
 * lookup happened at all never runs against a real id. So the fixtures here are
 * rows, and the ids are the ones the database actually mints.
 */

import { closePostgres, connectPostgres } from '../db/postgres';
import { clearPostScope, postScope, seedChannel, seedLane, seedPost } from './helpers/postFixtures';
import {
  ChannelReplyError,
  assertParentAcceptsReplies,
  isChannelPost,
  parentIsChannelPost,
} from '../utils/channelReplyGate';

const scope = postScope('channel-reply-gate');

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('isChannelPost — the ONE predicate', () => {
  it('is true only for a non-empty string channelId', () => {
    expect(isChannelPost({ channelId: 'chan_1' })).toBe(true);
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
    expect(isChannelPost({ laneId: 'lane_1' } as { channelId?: unknown })).toBe(false);
  });
});

describe('parentIsChannelPost', () => {
  it('answers false for no id at all', async () => {
    expect(await parentIsChannelPost(undefined)).toBe(false);
    expect(await parentIsChannelPost('')).toBe(false);
  });

  it('answers true for a parent that belongs to a channel', async () => {
    const parent = await seedPost(scope, { channelId: await seedChannel(scope) });
    expect(await parentIsChannelPost(parent.id)).toBe(true);
  });

  it('answers false for a parent that does not, and for one that is gone', async () => {
    const plain = await seedPost(scope);
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
    const parent = await seedPost(scope, { channelId: await seedChannel(scope) });
    expect(parent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(await parentIsChannelPost(parent.id)).toBe(true);
  });
});

describe('assertParentAcceptsReplies', () => {
  it('throws a 403 ChannelReplyError for a channel parent', async () => {
    const parent = await seedPost(scope, { channelId: await seedChannel(scope) });
    await expect(assertParentAcceptsReplies(parent.id)).rejects.toBeInstanceOf(ChannelReplyError);
    await expect(assertParentAcceptsReplies(parent.id)).rejects.toMatchObject({ status: 403 });
  });

  it('resolves for an ordinary parent, and for one that carries a lane', async () => {
    const plain = await seedPost(scope);
    await expect(assertParentAcceptsReplies(plain.id)).resolves.toBeUndefined();

    const laned = await seedPost(scope, { laneId: await seedLane(scope) });
    await expect(assertParentAcceptsReplies(laned.id)).resolves.toBeUndefined();
  });
});
