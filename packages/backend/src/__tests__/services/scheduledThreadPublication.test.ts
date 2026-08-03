import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
 * These cases drive the REAL sweep through the REAL claim over REAL ROWS, so
 * both mechanisms are exercised together and against each other:
 *
 * 1. `claimAndPublishScheduledPost` refuses a post whose parent has not
 *    published. Structural — it does not care who is calling or in what order.
 * 2. `ScheduledPostPublisher` walks each chain parent-first and stops at the
 *    first post that does not go out. Liveness — it makes the thread arrive
 *    whole on one tick.
 *
 * The in-memory `Post` this replaces reproduced the claim's conditional update
 * by hand, which is the one thing a double cannot stand in for: whether the
 * filter really excludes a row another statement has already flipped is a
 * question about Postgres, not about the matcher the test wrote.
 *
 * Only the publish PIPELINE is stubbed (`publishScheduledPost`), because what is
 * under test is which posts reach it and in what order, not what it does when
 * they do.
 */

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import type { PostRecord } from '../../db/posts/postRecord';
import { postCreationService } from '../../services/PostCreationService';
import { scheduledPostPublisher } from '../../services/ScheduledPostPublisher';
import { pastSweepWindow } from './scheduledPublisherWindow';

const scope = serviceScope('scheduled-thread-publication');
const AUTHOR = scope.user('author');
const DUE = new Date('2026-01-01T09:00:00.000Z');
const NOW = new Date('2026-01-01T09:00:30.000Z');

/** Label → the id the repository minted, so assertions read as the thread does. */
let idByLabel: Map<string, string>;
/** The reverse, for turning a publish call back into a label. */
let labelById: Map<string, string>;

/** The order posts actually reached the publish pipeline, by label. */
let publishOrder: string[];
/** Labels whose pipeline should throw. */
let pipelineFailures: Set<string>;

const publishSpy = vi.spyOn(postCreationService, 'publishScheduledPost');

/**
 * Seed one scheduled post per label, parents first (the foreign key requires
 * it).
 *
 * Every post carries the SAME `scheduled_for` — the one time the author picked —
 * which is exactly why the sweep cannot rely on the due set's own order.
 */
async function seedPosts(specs: Array<[label: string, parent: string | null]>): Promise<void> {
  for (const [label, parent] of specs) {
    const record = await seedPost(scope, {
      oxyUserId: AUTHOR,
      status: 'scheduled',
      scheduledFor: DUE,
      ...(parent ? { parentPostId: idByLabel.get(parent) } : {}),
    });
    idByLabel.set(label, record.id);
    labelById.set(record.id, label);
  }
}

/** A three-post scheduled thread, all carrying the one time the author picked. */
function seedThread(): Promise<void> {
  return seedPosts([['root', null], ['c1', 'root'], ['c2', 'c1']]);
}

async function statuses(): Promise<Record<string, string | undefined>> {
  const entries = await Promise.all(
    [...idByLabel].map(async ([label, id]) => [label, (await readPost(id))?.status] as const),
  );
  return Object.fromEntries(entries);
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  publishSpy.mockRestore();
  await closePostgres();
});

beforeEach(() => {
  idByLabel = new Map();
  labelById = new Map();
  publishOrder = [];
  pipelineFailures = new Set();
  publishSpy.mockReset();
  publishSpy.mockImplementation(async (post: PostRecord) => {
    const label = labelById.get(post.id) ?? post.id;
    publishOrder.push(label);
    if (pipelineFailures.has(label)) {
      throw new Error(`publish pipeline failed for ${label}`);
    }
    return post;
  });
});

afterEach(async () => {
  await clearServiceScope(scope);
});

describe('a scheduled thread publishes as one unit, in order', () => {
  it('publishes root before every continuation, on a single sweep', async () => {
    await seedThread();

    const published = await scheduledPostPublisher.publishDuePosts(pastSweepWindow(NOW));

    expect(published).toBe(3);
    expect(publishOrder).toEqual(['root', 'c1', 'c2']);
  });

  /**
   * Insertion order is not publication order.
   *
   * The due set comes back ordered by `scheduled_for`, and every post of a
   * thread carries the SAME time — so the order the sweep receives is decided by
   * whatever the secondary key happens to be, not by the thread. `c2` is seeded
   * LAST here and must still publish last for the right reason: because the
   * chain walk put it there, not because the read did.
   */
  it('orders the chain rather than trusting the order the due set arrives in', async () => {
    await seedThread();

    await scheduledPostPublisher.publishDuePosts(pastSweepWindow(NOW));

    expect(publishOrder).toEqual(['root', 'c1', 'c2']);
  });

  it('still publishes independent posts concurrently — a beast batch is unchanged', async () => {
    await seedPosts([['a', null], ['b', null], ['c', null]]);

    const published = await scheduledPostPublisher.publishDuePosts(pastSweepWindow(NOW));

    expect(published).toBe(3);
    expect([...publishOrder].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('a partial failure never leaves a continuation ahead of its parent', () => {
  it('stops the chain when a post in the middle fails to publish', async () => {
    await seedThread();
    pipelineFailures.add('c1');

    const published = await scheduledPostPublisher.publishDuePosts(pastSweepWindow(NOW));

    // `c2` was never even attempted: it replies to a post that did not go out.
    expect(publishOrder).toEqual(['root', 'c1']);
    expect(published).toBe(1);
    expect((await statuses()).c2).toBe('scheduled');
  });

  it('resumes the chain from where it stopped on the next sweep', async () => {
    await seedThread();
    pipelineFailures.add('c1');
    await scheduledPostPublisher.publishDuePosts(pastSweepWindow(NOW));

    // The failure was transient. The CLAIM already flipped `c1` — that write
    // committed before the pipeline threw — so `c2` is now free to follow it,
    // and the next sweep picks up only what is still scheduled.
    pipelineFailures.clear();
    publishOrder = [];

    await scheduledPostPublisher.publishDuePosts(pastSweepWindow(NOW));

    expect(publishOrder).toEqual(['c2']);
    expect(await statuses()).toEqual({
      root: 'published',
      c1: 'published',
      c2: 'published',
    });
  });

  it('does not let one broken thread hold up anybody else', async () => {
    await seedPosts([
      ['a-root', null],
      ['a-1', 'a-root'],
      ['b-root', null],
      ['b-1', 'b-root'],
    ]);
    pipelineFailures.add('a-root');

    const published = await scheduledPostPublisher.publishDuePosts(pastSweepWindow(NOW));

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
    await seedThread();

    const result = await postCreationService.claimAndPublishScheduledPost({
      postId: idByLabel.get('c2') as string,
    });

    expect(result).toBeNull();
    expect(publishOrder).toEqual([]);
    expect(await statuses()).toEqual({
      root: 'scheduled',
      c1: 'scheduled',
      c2: 'scheduled',
    });
  });

  it('allows it the moment its parent has published', async () => {
    await seedThread();
    // Parent-first, because the claim refuses each of these for the same reason
    // `c2` is refused above — the invariant is a chain, not a single hop.
    await postCreationService.claimAndPublishScheduledPost({
      postId: idByLabel.get('root') as string,
    });
    await postCreationService.claimAndPublishScheduledPost({
      postId: idByLabel.get('c1') as string,
    });
    publishOrder = [];

    const result = await postCreationService.claimAndPublishScheduledPost({
      postId: idByLabel.get('c2') as string,
    });

    expect(result).not.toBeNull();
    expect(publishOrder).toEqual(['c2']);
  });
});
