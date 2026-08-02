import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';
import { scheduledPostPublisher } from '../../services/ScheduledPostPublisher';
import { closePostgres, connectPostgres } from '../../db/postgres';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecord } from '../../db/posts/postRecord';
import { postCreationService } from '../../services/PostCreationService';

/**
 * The scheduled-publish sweep, against REAL ROWS.
 *
 * The previous version stubbed `Post.find(...).sort().limit()` and asserted the
 * FILTER OBJECT the sweep passed. That could not tell a correct due-post
 * predicate from one that matched nothing — and "matched nothing" is exactly
 * what a broken scheduler looks like: every scheduled post silently never goes
 * live, with no error anywhere. The predicate is SQL now, so the only assertion
 * that discriminates is which rows come back.
 *
 * `publishScheduledPost` is still stubbed: this suite is about SELECTION, ORDER
 * and per-post isolation, and the publish pipeline itself (invites, MTN,
 * notifications, federation) has its own coverage.
 */
vi.mock('../../services/PostCreationService', () => ({
  postCreationService: {
    publishScheduledPost: vi.fn(async (post: PostRecord) => post),
  },
}));

const AUTHOR = 'oxy-scheduled-author';
const created: string[] = [];

const publishSpy = postCreationService.publishScheduledPost as unknown as ReturnType<typeof vi.fn>;

async function seedScheduled(
  scheduledFor: Date,
  overrides: { status?: 'draft' | 'published' | 'scheduled' } = {},
): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: overrides.status ?? 'scheduled',
    scheduledFor,
    content: { variants: [{ source: 'author', text: 'later', tag: 'en' }] },
  });
  created.push(record.id);
  return record.id;
}

/** The post ids the sweep actually handed to the publish pipeline. */
function publishedIds(): string[] {
  return publishSpy.mock.calls.map(([post]) => (post as PostRecord).id);
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  publishSpy.mockClear();
  publishSpy.mockImplementation(async (post: PostRecord) => post);
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id, undefined);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('ScheduledPostPublisher', () => {
  it('publishes every due scheduled post and returns the count', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const first = await seedScheduled(new Date('2026-01-01T10:00:00.000Z'));
    const second = await seedScheduled(new Date('2026-01-01T11:00:00.000Z'));

    const published = await scheduledPostPublisher.publishDuePosts(now);

    expect(published).toBe(2);
    expect(publishedIds()).toEqual([first, second]);
  });

  it('leaves a post whose time has not arrived, and a post that is not scheduled', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const due = await seedScheduled(new Date('2026-01-01T09:00:00.000Z'));
    const future = await seedScheduled(new Date('2026-01-01T18:00:00.000Z'));
    // Same due time, but already published — the status arm of the predicate is
    // what keeps the sweep from re-publishing (and re-federating) live posts.
    const alreadyLive = await seedScheduled(new Date('2026-01-01T09:00:00.000Z'), {
      status: 'published',
    });

    const published = await scheduledPostPublisher.publishDuePosts(now);

    expect(published).toBe(1);
    expect(publishedIds()).toEqual([due]);
    expect(publishedIds()).not.toContain(future);
    expect(publishedIds()).not.toContain(alreadyLive);
  });

  it('publishes oldest-first, so a backlog goes live in the order it was scheduled', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const newest = await seedScheduled(new Date('2026-01-01T11:00:00.000Z'));
    const oldest = await seedScheduled(new Date('2026-01-01T08:00:00.000Z'));
    const middle = await seedScheduled(new Date('2026-01-01T10:00:00.000Z'));

    await scheduledPostPublisher.publishDuePosts(now);

    expect(publishedIds()).toEqual([oldest, middle, newest]);
  });

  it('isolates a failing post so the rest of the batch still publishes', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    const ok1 = await seedScheduled(new Date('2026-01-01T08:00:00.000Z'));
    const boom = await seedScheduled(new Date('2026-01-01T09:00:00.000Z'));
    const ok2 = await seedScheduled(new Date('2026-01-01T10:00:00.000Z'));

    publishSpy.mockImplementation(async (post: PostRecord) => {
      if (post.id === boom) throw new Error('publish failed');
      return post;
    });

    const published = await scheduledPostPublisher.publishDuePosts(now);

    expect(published).toBe(2);
    expect(publishedIds()).toEqual([ok1, boom, ok2]);
  });
});
