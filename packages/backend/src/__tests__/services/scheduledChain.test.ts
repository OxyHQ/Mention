import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * The ordering primitives a scheduled THREAD publishes by.
 *
 * `orderScheduledChains` is pure and answers "what must publish before what" for
 * one sweep's worth of due posts. `loadScheduledChain` and `parentHasPublished`
 * answer the same question against the DATABASE, and are what make cancelling,
 * rescheduling and publishing-early act on the whole thread instead of one row
 * of it.
 *
 * The two database functions run on real rows. Their previous form stubbed
 * `Post.findById().select().lean()` and answered from an in-memory array, which
 * cannot distinguish a correct query from one that matches nothing — and
 * "matches nothing" is precisely how this breaks: a chain that comes back empty
 * looks like a lone scheduled post, so a thread publishes one row at a time with
 * no error anywhere. The down-walk in particular carries three ANDed predicates
 * (parent, owner, still-scheduled); dropping any one of them is invisible to a
 * filter-shape assertion.
 */

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import {
  loadScheduledChain,
  orderScheduledChains,
  parentHasPublished,
} from '../../services/scheduledChain';

const scope = serviceScope('scheduled-chain');
const AUTHOR = scope.user('author');
const OTHER = scope.user('other-author');

/** A future instant, so a seeded scheduled post is never swept as due. */
function later(minutes = 60): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('orderScheduledChains', () => {
  it('orders a thread parent before child', () => {
    const chains = orderScheduledChains([
      { id: 'c2', parentPostId: 'c1' },
      { id: 'root', parentPostId: null },
      { id: 'c1', parentPostId: 'root' },
    ]);

    expect(chains).toHaveLength(1);
    expect(chains[0].map((p) => p.id)).toEqual(['root', 'c1', 'c2']);
  });

  it('leaves independent posts as chains of one, so a beast batch keeps its concurrency', () => {
    const chains = orderScheduledChains([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    expect(chains.map((chain) => chain.map((p) => p.id))).toEqual([['a'], ['b'], ['c']]);
  });

  it('separates two threads so one cannot hold up the other', () => {
    const chains = orderScheduledChains([
      { id: 'a-root', parentPostId: null },
      { id: 'b-root', parentPostId: null },
      { id: 'b-1', parentPostId: 'b-root' },
      { id: 'a-1', parentPostId: 'a-root' },
    ]);

    expect(chains.map((chain) => chain.map((p) => p.id))).toEqual([
      ['a-root', 'a-1'],
      ['b-root', 'b-1'],
    ]);
  });

  /**
   * The batch cap can cut a thread in half. The tail must then start its own
   * chain rather than be dropped — it is safe to attempt, because the claim
   * refuses it while the head is still unpublished, and it publishes on the very
   * next sweep once the head has gone out.
   */
  it('treats a tail whose parent is outside the batch as its own chain', () => {
    const chains = orderScheduledChains([
      { id: 'c2', parentPostId: 'c1' },
      { id: 'c3', parentPostId: 'c2' },
    ]);

    expect(chains.map((chain) => chain.map((p) => p.id))).toEqual([['c2', 'c3']]);
  });
});

describe('loadScheduledChain', () => {
  /** A scheduled self-thread: root -> c1 -> c2, all the same author. */
  async function seedThread(): Promise<{ root: string; c1: string; c2: string }> {
    const root = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'scheduled',
      scheduledFor: later(),
    });
    const c1 = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'scheduled',
      scheduledFor: later(),
      parentPostId: root.id,
    });
    const c2 = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'scheduled',
      scheduledFor: later(),
      parentPostId: c1.id,
    });
    return { root: root.id, c1: c1.id, c2: c2.id };
  }

  it('returns the whole thread from a MIDDLE post, root first', async () => {
    const { root, c1, c2 } = await seedThread();

    expect(await loadScheduledChain(c1, AUTHOR)).toEqual({ ok: true, postIds: [root, c1, c2] });
  });

  it('stops climbing at an ancestor that already published', async () => {
    const parent = await seedPost(scope, { oxyUserId: AUTHOR });
    const reply = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'scheduled',
      scheduledFor: later(),
      parentPostId: parent.id,
    });

    // A scheduled reply to a post already on screen is its own chain: nothing it
    // depends on is still to come.
    expect(await loadScheduledChain(reply.id, AUTHOR)).toEqual({ ok: true, postIds: [reply.id] });
  });

  it('stops climbing when the parent is gone', async () => {
    // `parent_post_id` is `ON DELETE SET NULL`, so a deleted parent leaves the
    // reply with no link at all — the same state a post written with none has.
    const orphan = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'scheduled',
      scheduledFor: later(),
    });

    expect(await loadScheduledChain(orphan.id, AUTHOR)).toEqual({ ok: true, postIds: [orphan.id] });
  });

  it('refuses when a still-scheduled ancestor belongs to somebody else', async () => {
    const theirs = await seedPost(scope, {
      oxyUserId: OTHER,
      status: 'scheduled',
      scheduledFor: later(),
    });
    const mine = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'scheduled',
      scheduledFor: later(),
      parentPostId: theirs.id,
    });

    // Publishing `mine` would put a reply on screen ahead of the post it
    // answers, and this caller cannot publish that post.
    expect(await loadScheduledChain(mine.id, AUTHOR)).toEqual({
      ok: false,
      reason: 'foreign_scheduled_ancestor',
    });
  });

  it("excludes another author's scheduled reply from the chain it walks down", async () => {
    const root = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'scheduled',
      scheduledFor: later(),
    });
    await seedPost(scope, {
      oxyUserId: OTHER,
      status: 'scheduled',
      scheduledFor: later(),
      parentPostId: root.id,
    });

    expect(await loadScheduledChain(root.id, AUTHOR)).toEqual({ ok: true, postIds: [root.id] });
  });

  it('excludes an already-published reply from the chain it walks down', async () => {
    const root = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'scheduled',
      scheduledFor: later(),
    });
    await seedPost(scope, { oxyUserId: AUTHOR, parentPostId: root.id });

    expect(await loadScheduledChain(root.id, AUTHOR)).toEqual({ ok: true, postIds: [root.id] });
  });

  it('is empty for a post that no longer exists', async () => {
    expect(await loadScheduledChain('019fffff-ffff-7fff-bfff-ffffffffffff', AUTHOR)).toEqual({
      ok: true,
      postIds: [],
    });
  });
});

describe('parentHasPublished', () => {
  it('passes a post with no parent', async () => {
    expect(await parentHasPublished({})).toBe(true);
  });

  it('refuses while the parent is still scheduled', async () => {
    const root = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'scheduled',
      scheduledFor: later(),
    });

    expect(await parentHasPublished({ parentPostId: root.id })).toBe(false);
  });

  it('passes once the parent has published', async () => {
    const root = await seedPost(scope, { oxyUserId: AUTHOR });

    expect(await parentHasPublished({ parentPostId: root.id })).toBe(true);
  });

  /**
   * The invariant is "no continuation before its parent"; with no parent there
   * is nothing to precede. A scheduled reply whose parent was deleted after it
   * was scheduled must still go out rather than wedge in the queue forever.
   */
  it('passes when the parent has been deleted', async () => {
    expect(
      await parentHasPublished({ parentPostId: '019fffff-ffff-7fff-bfff-ffffffffffff' }),
    ).toBe(true);
  });
});
