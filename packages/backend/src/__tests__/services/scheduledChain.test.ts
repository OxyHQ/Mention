import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ordering primitives a scheduled THREAD publishes by.
 *
 * `orderScheduledChains` is pure and answers "what must publish before what" for
 * one sweep's worth of due posts. `loadScheduledChain` answers the same question
 * against the database for one post, and is what makes cancelling, rescheduling
 * and publishing-early act on the whole thread instead of one row of it.
 */

const hoisted = vi.hoisted(() => ({
  docs: [] as Record<string, unknown>[],
}));

/** The `findById().select().lean()` / `find().select().sort().lean()` subset used here. */
vi.mock('../../models/Post', () => {
  const find = (filter: Record<string, unknown>) =>
    hoisted.docs.filter((doc) => Object.entries(filter).every(([k, v]) => doc[k] === v));
  const chainable = (rows: Record<string, unknown>[]) => ({
    select: () => chainable(rows),
    sort: () => chainable(rows),
    lean: async () => rows,
  });
  return {
    Post: {
      findById: (id: unknown) => {
        const row = hoisted.docs.find((doc) => String(doc._id) === String(id));
        return {
          select: () => ({ lean: async () => row ?? null }),
        };
      },
      find: (filter: Record<string, unknown>) => chainable(find(filter)),
    },
  };
});

import {
  loadScheduledChain,
  orderScheduledChains,
  parentHasPublished,
} from '../../services/scheduledChain';

const AUTHOR = 'author_1';

function seed(docs: Record<string, unknown>[]) {
  hoisted.docs = docs;
}

/** A scheduled self-thread: root -> c1 -> c2, all the same author. */
function seedThread() {
  seed([
    { _id: 'root', status: 'scheduled', oxyUserId: AUTHOR, parentPostId: null, createdAt: 1 },
    { _id: 'c1', status: 'scheduled', oxyUserId: AUTHOR, parentPostId: 'root', createdAt: 2 },
    { _id: 'c2', status: 'scheduled', oxyUserId: AUTHOR, parentPostId: 'c1', createdAt: 3 },
  ]);
}

describe('orderScheduledChains', () => {
  it('orders a thread parent before child', () => {
    const chains = orderScheduledChains([
      { _id: 'c2', parentPostId: 'c1' },
      { _id: 'root', parentPostId: null },
      { _id: 'c1', parentPostId: 'root' },
    ]);

    expect(chains).toHaveLength(1);
    expect(chains[0].map((p) => p._id)).toEqual(['root', 'c1', 'c2']);
  });

  it('leaves independent posts as chains of one, so a beast batch keeps its concurrency', () => {
    const chains = orderScheduledChains([{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }]);

    expect(chains.map((chain) => chain.map((p) => p._id))).toEqual([['a'], ['b'], ['c']]);
  });

  it('separates two threads so one cannot hold up the other', () => {
    const chains = orderScheduledChains([
      { _id: 'a-root', parentPostId: null },
      { _id: 'b-root', parentPostId: null },
      { _id: 'b-1', parentPostId: 'b-root' },
      { _id: 'a-1', parentPostId: 'a-root' },
    ]);

    expect(chains.map((chain) => chain.map((p) => p._id))).toEqual([
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
      { _id: 'c2', parentPostId: 'c1' },
      { _id: 'c3', parentPostId: 'c2' },
    ]);

    expect(chains.map((chain) => chain.map((p) => p._id))).toEqual([['c2', 'c3']]);
  });
});

describe('loadScheduledChain', () => {
  beforeEach(() => {
    hoisted.docs = [];
  });

  it('returns the whole thread from a MIDDLE post, root first', async () => {
    seedThread();

    const chain = await loadScheduledChain('c1', AUTHOR);

    expect(chain).toEqual({ ok: true, postIds: ['root', 'c1', 'c2'] });
  });

  it('stops climbing at an ancestor that already published', async () => {
    seed([
      { _id: 'published-parent', status: 'published', oxyUserId: AUTHOR, parentPostId: null },
      { _id: 'reply', status: 'scheduled', oxyUserId: AUTHOR, parentPostId: 'published-parent' },
    ]);

    // A scheduled reply to a post already on screen is its own chain: nothing it
    // depends on is still to come.
    expect(await loadScheduledChain('reply', AUTHOR)).toEqual({ ok: true, postIds: ['reply'] });
  });

  it('stops climbing when the parent is gone', async () => {
    seed([{ _id: 'orphan', status: 'scheduled', oxyUserId: AUTHOR, parentPostId: 'deleted' }]);

    expect(await loadScheduledChain('orphan', AUTHOR)).toEqual({ ok: true, postIds: ['orphan'] });
  });

  it('refuses when a still-scheduled ancestor belongs to somebody else', async () => {
    seed([
      { _id: 'theirs', status: 'scheduled', oxyUserId: 'other_author', parentPostId: null },
      { _id: 'mine', status: 'scheduled', oxyUserId: AUTHOR, parentPostId: 'theirs' },
    ]);

    // Publishing `mine` would put a reply on screen ahead of the post it
    // answers, and this caller cannot publish that post.
    expect(await loadScheduledChain('mine', AUTHOR)).toEqual({
      ok: false,
      reason: 'foreign_scheduled_ancestor',
    });
  });

  it('excludes another author\'s scheduled reply from the chain it walks down', async () => {
    seed([
      { _id: 'root', status: 'scheduled', oxyUserId: AUTHOR, parentPostId: null },
      { _id: 'theirs', status: 'scheduled', oxyUserId: 'other_author', parentPostId: 'root' },
    ]);

    expect(await loadScheduledChain('root', AUTHOR)).toEqual({ ok: true, postIds: ['root'] });
  });

  it('is empty for a post that no longer exists', async () => {
    seed([]);

    expect(await loadScheduledChain('gone', AUTHOR)).toEqual({ ok: true, postIds: [] });
  });
});

describe('parentHasPublished', () => {
  beforeEach(() => {
    hoisted.docs = [];
  });

  it('passes a post with no parent', async () => {
    expect(await parentHasPublished({})).toBe(true);
  });

  it('refuses while the parent is still scheduled', async () => {
    seed([{ _id: 'root', status: 'scheduled' }]);

    expect(await parentHasPublished({ parentPostId: 'root' })).toBe(false);
  });

  it('passes once the parent has published', async () => {
    seed([{ _id: 'root', status: 'published' }]);

    expect(await parentHasPublished({ parentPostId: 'root' })).toBe(true);
  });

  /**
   * The invariant is "no continuation before its parent"; with no parent there
   * is nothing to precede. A scheduled reply whose parent was deleted after it
   * was scheduled must still go out rather than wedge in the queue forever.
   */
  it('passes when the parent has been deleted', async () => {
    seed([]);

    expect(await parentHasPublished({ parentPostId: 'deleted' })).toBe(true);
  });
});
