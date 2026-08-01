import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The invariant a scheduled THREAD exists to uphold:
 *
 *   **No continuation is ever visible before its parent** — including when
 *   publishing fails midway.
 *
 * A thread's continuations are created as replies to one another, so publishing
 * them independently (as a beast batch is published) could put an answer on
 * screen before the post it answers: a broken thread real readers can see, and
 * one that cannot be reordered afterwards.
 *
 * These cases drive the REAL sweep through the REAL claim over an in-memory
 * Post, so both mechanisms are exercised together and against each other:
 *
 * 1. `claimAndPublishScheduledPost` refuses a post whose parent has not
 *    published. Structural — it does not care who is calling or in what order.
 * 2. `ScheduledPostPublisher` walks each chain parent-first and stops at the
 *    first post that does not go out. Liveness — it makes the thread arrive
 *    whole on one tick.
 *
 * Only the publish PIPELINE is stubbed (`publishScheduledPost`), because what is
 * under test is which posts reach it and in what order, not what it does when
 * they do.
 */

interface StoredPost {
  _id: string;
  oxyUserId: string;
  status: string;
  parentPostId: string | null;
  scheduledFor: Date;
}

const hoisted = vi.hoisted(() => ({
  docs: [] as {
    _id: string;
    oxyUserId: string;
    status: string;
    parentPostId: string | null;
    scheduledFor: Date;
  }[],
}));

vi.mock('../../models/Post', async (importOriginal) => {
  const chainable = (rows: unknown[]) => {
    const self: Record<string, unknown> = {};
    self.sort = () => self;
    self.select = () => self;
    self.limit = async () => rows;
    self.lean = async () => rows;
    self.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return self;
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    Post: {
      find: (filter: Record<string, unknown>) =>
        chainable(
          hoisted.docs.filter(
            (doc) =>
              (filter.status === undefined || doc.status === filter.status) &&
              (filter.scheduledFor === undefined ||
                doc.scheduledFor <= (filter.scheduledFor as { $lte: Date }).$lte),
          ),
        ),
      findById: (id: unknown) => ({
        select: () => ({
          lean: async () => hoisted.docs.find((doc) => doc._id === String(id)) ?? null,
        }),
      }),
      findOneAndUpdate: async (filter: Record<string, unknown>) => {
        const doc = hoisted.docs.find((d) => d._id === String(filter._id));
        if (!doc) return null;
        if (filter.status !== undefined && doc.status !== filter.status) return null;
        if (filter.oxyUserId !== undefined && doc.oxyUserId !== filter.oxyUserId) return null;
        doc.status = 'published';
        return doc;
      },
    },
  };
});

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

import { postCreationService } from '../../services/PostCreationService';
import { scheduledPostPublisher } from '../../services/ScheduledPostPublisher';

const AUTHOR = 'author_1';
const DUE = new Date('2026-01-01T09:00:00.000Z');
const NOW = new Date('2026-01-01T09:00:30.000Z');

/** The order posts actually reached the publish pipeline. */
let publishOrder: string[];
/** Posts whose pipeline should throw, keyed by id. */
let pipelineFailures: Set<string>;

function post(id: string, parentPostId: string | null): StoredPost {
  return { _id: id, oxyUserId: AUTHOR, status: 'scheduled', parentPostId, scheduledFor: DUE };
}

/** A three-post scheduled thread, all carrying the one time the author picked. */
function seedThread() {
  hoisted.docs = [post('root', null), post('c1', 'root'), post('c2', 'c1')];
}

function statuses(): Record<string, string> {
  return Object.fromEntries(hoisted.docs.map((doc) => [doc._id, doc.status]));
}

beforeEach(() => {
  vi.restoreAllMocks();
  publishOrder = [];
  pipelineFailures = new Set();
  vi.spyOn(postCreationService, 'publishScheduledPost').mockImplementation(
    async (post: { _id: unknown }) => {
      const id = String(post._id);
      publishOrder.push(id);
      if (pipelineFailures.has(id)) {
        throw new Error(`publish pipeline failed for ${id}`);
      }
      return post as never;
    },
  );
});

describe('a scheduled thread publishes as one unit, in order', () => {
  it('publishes root before every continuation, on a single sweep', async () => {
    seedThread();

    const published = await scheduledPostPublisher.publishDuePosts(NOW);

    expect(published).toBe(3);
    expect(publishOrder).toEqual(['root', 'c1', 'c2']);
  });

  /**
   * Insertion order is not publication order. Mongo returns the due set sorted
   * by `scheduledFor`, and every post of a thread carries the SAME time, so the
   * tie is broken arbitrarily — which is precisely why the chain has to be
   * ordered rather than trusted.
   */
  it('orders the chain even when the due set arrives back to front', async () => {
    hoisted.docs = [post('c2', 'c1'), post('c1', 'root'), post('root', null)];

    await scheduledPostPublisher.publishDuePosts(NOW);

    expect(publishOrder).toEqual(['root', 'c1', 'c2']);
  });

  it('still publishes independent posts concurrently — a beast batch is unchanged', async () => {
    hoisted.docs = [post('a', null), post('b', null), post('c', null)];

    const published = await scheduledPostPublisher.publishDuePosts(NOW);

    expect(published).toBe(3);
    expect(publishOrder.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('a partial failure never leaves a continuation ahead of its parent', () => {
  it('stops the chain when a post in the middle fails to publish', async () => {
    seedThread();
    pipelineFailures.add('c1');

    const published = await scheduledPostPublisher.publishDuePosts(NOW);

    // `c2` was never even attempted: it replies to a post that did not go out.
    expect(publishOrder).toEqual(['root', 'c1']);
    expect(published).toBe(1);
    expect(statuses().c2).toBe('scheduled');
  });

  it('resumes the chain from where it stopped on the next sweep', async () => {
    seedThread();
    pipelineFailures.add('c1');
    await scheduledPostPublisher.publishDuePosts(NOW);

    // The failure was transient; `c1` is retried and the tail follows it.
    pipelineFailures.clear();
    publishOrder = [];
    // The claim already flipped `c1` (that write committed before the pipeline
    // threw), so the retry is of the pipeline, and `c2` is now free to follow.
    hoisted.docs = hoisted.docs.map((doc) =>
      doc._id === 'c1' ? { ...doc, status: 'scheduled' } : doc,
    );

    await scheduledPostPublisher.publishDuePosts(NOW);

    expect(publishOrder).toEqual(['c1', 'c2']);
    expect(statuses()).toEqual({ root: 'published', c1: 'published', c2: 'published' });
  });

  it('does not let one broken thread hold up anybody else', async () => {
    hoisted.docs = [
      post('a-root', null),
      post('a-1', 'a-root'),
      post('b-root', null),
      post('b-1', 'b-root'),
    ];
    pipelineFailures.add('a-root');

    const published = await scheduledPostPublisher.publishDuePosts(NOW);

    expect(publishOrder).toContain('b-root');
    expect(publishOrder).toContain('b-1');
    expect(publishOrder).not.toContain('a-1');
    expect(published).toBe(2);
  });
});

describe('the claim refuses an out-of-turn continuation on its own', () => {
  /**
   * The ordering above is for liveness. THIS is the safety property: even a
   * caller that ignores the chain entirely — a stray retry, a future surface, a
   * sweep racing the author — cannot publish a continuation early.
   */
  it('refuses a continuation while its parent is still scheduled', async () => {
    seedThread();

    const result = await postCreationService.claimAndPublishScheduledPost({ postId: 'c2' });

    expect(result).toBeNull();
    expect(publishOrder).toEqual([]);
    expect(statuses()).toEqual({ root: 'scheduled', c1: 'scheduled', c2: 'scheduled' });
  });

  it('allows it the moment its parent has published', async () => {
    seedThread();
    hoisted.docs = hoisted.docs.map((doc) =>
      doc._id === 'c1' ? { ...doc, status: 'published' } : doc,
    );

    const result = await postCreationService.claimAndPublishScheduledPost({ postId: 'c2' });

    expect(result).not.toBeNull();
    expect(publishOrder).toEqual(['c2']);
  });
});
