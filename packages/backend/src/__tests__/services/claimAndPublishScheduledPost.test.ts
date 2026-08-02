import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The claim that makes "publish now" safe, against REAL ROWS.
 *
 * `publishScheduledPost` flips the status on a record it was HANDED, so two
 * callers holding the same record both run the whole pipeline: federating twice,
 * writing two MTN records, notifying twice. That is reachable — the 60s sweep
 * can load a due post moments before its author taps "post now".
 *
 * The mutual exclusion is a conditional `UPDATE … WHERE status = 'scheduled'
 * RETURNING`, and it is the one thing here a mock cannot stand in for. The
 * previous form drove an in-memory document through a hand-written filter
 * matcher, which tests the matcher: the real question is whether TWO concurrent
 * statements against one Postgres row can both come back with a row, and only
 * Postgres can answer it. The row lock is what makes the loser re-check the
 * COMMITTED status and match nothing.
 */

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { postCreationService } from '../../services/PostCreationService';
import type { PostRecord } from '../../db/posts/postRecord';

const scope = serviceScope('claim-and-publish');
const OWNER = scope.user('author');
const STRANGER = scope.user('someone-else');

const publishSpy = vi.spyOn(postCreationService, 'publishScheduledPost');

/** A future instant, so a seeded scheduled post is never swept as due. */
function later(minutes = 60): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

async function seedScheduled(
  overrides: { status?: 'scheduled' | 'published'; oxyUserId?: string; parentPostId?: string } = {},
): Promise<string> {
  const record = await seedPost(scope, {
    oxyUserId: overrides.oxyUserId ?? OWNER,
    status: overrides.status ?? 'scheduled',
    ...(overrides.status === 'published' ? {} : { scheduledFor: later() }),
    ...(overrides.parentPostId ? { parentPostId: overrides.parentPostId } : {}),
  });
  return record.id;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  publishSpy.mockClear();
  // The publish pipeline itself is covered by its own tests; here it only has to
  // be observable, so the claim's effect on how OFTEN it runs is what shows.
  publishSpy.mockImplementation(async (post: PostRecord) => post);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  publishSpy.mockRestore();
  await closePostgres();
});

describe('claimAndPublishScheduledPost — exactly once', () => {
  it('publishes a scheduled post the owner claims, and the row is published after', async () => {
    const postId = await seedScheduled();

    const result = await postCreationService.claimAndPublishScheduledPost({ postId, ownerId: OWNER });

    expect(result).not.toBeNull();
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect((await readPost(postId))?.status).toBe('published');
  });

  it('runs the publish pipeline ONCE when two callers race', async () => {
    const postId = await seedScheduled();

    // The author tapping "post now" while the sweep is mid-batch on the same
    // post. Both statements are issued before either resolves, so this is the
    // real contention rather than a simulation of it.
    const [author, sweep] = await Promise.all([
      postCreationService.claimAndPublishScheduledPost({ postId, ownerId: OWNER }),
      postCreationService.claimAndPublishScheduledPost({ postId }),
    ]);

    const winners = [author, sweep].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    // The point of the whole exercise: one federation, one MTN record, one set
    // of notifications.
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a second publish of a post that already went out', async () => {
    const postId = await seedScheduled({ status: 'published' });

    const result = await postCreationService.claimAndPublishScheduledPost({ postId, ownerId: OWNER });

    expect(result).toBeNull();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('refuses a post that does not exist', async () => {
    const result = await postCreationService.claimAndPublishScheduledPost({
      postId: '019fffff-ffff-7fff-bfff-ffffffffffff',
      ownerId: OWNER,
    });

    expect(result).toBeNull();
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

describe('claimAndPublishScheduledPost — ownership', () => {
  it("REFUSES to publish another user's scheduled post", async () => {
    const postId = await seedScheduled();

    const result = await postCreationService.claimAndPublishScheduledPost({
      postId,
      ownerId: STRANGER,
    });

    expect(result).toBeNull();
    expect(publishSpy).not.toHaveBeenCalled();
    expect((await readPost(postId))?.status).toBe('scheduled');
  });

  it('leaves the post publishable by its real owner after a stranger is refused', async () => {
    const postId = await seedScheduled();

    await postCreationService.claimAndPublishScheduledPost({ postId, ownerId: STRANGER });
    const owner = await postCreationService.claimAndPublishScheduledPost({ postId, ownerId: OWNER });

    // A refused claim must not consume the post — otherwise anyone could grief
    // an author out of their own scheduled post.
    expect(owner).not.toBeNull();
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('lets the SWEEP publish without an owner, since it acts for nobody', async () => {
    const postId = await seedScheduled();

    const result = await postCreationService.claimAndPublishScheduledPost({ postId });

    expect(result).not.toBeNull();
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });
});

describe('claimAndPublishScheduledPost — a continuation waits for its parent', () => {
  it('refuses while the parent is still scheduled, and leaves it claimable', async () => {
    const parentId = await seedScheduled();
    const childId = await seedScheduled({ parentPostId: parentId });

    const result = await postCreationService.claimAndPublishScheduledPost({
      postId: childId,
      ownerId: OWNER,
    });

    // A reply on screen ahead of the post it answers is a broken thread real
    // readers can see, with no way to reorder it afterwards.
    expect(result).toBeNull();
    expect(publishSpy).not.toHaveBeenCalled();
    expect((await readPost(childId))?.status).toBe('scheduled');
  });

  it('publishes the continuation once its parent has gone out', async () => {
    const parentId = await seedScheduled();
    const childId = await seedScheduled({ parentPostId: parentId });

    await postCreationService.claimAndPublishScheduledPost({ postId: parentId, ownerId: OWNER });
    const child = await postCreationService.claimAndPublishScheduledPost({
      postId: childId,
      ownerId: OWNER,
    });

    expect(child).not.toBeNull();
    expect(publishSpy).toHaveBeenCalledTimes(2);
  });
});
