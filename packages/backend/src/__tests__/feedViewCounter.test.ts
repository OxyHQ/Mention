import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * View telemetry eligibility and counting, against REAL ROWS.
 *
 * The previous version stubbed `Post.exists` / `Post.findOneAndUpdate` and
 * asserted the FILTER OBJECTS. Three things it could not see:
 *
 *  - the id-shape pre-check is GONE. It used to reject anything that was not a
 *    valid ObjectId; `posts.id` is `text` holding an ObjectId hex before the
 *    cutover and a uuid v7 after, so keeping it would have made every post
 *    created since the cutover permanently ineligible — the counter simply stops
 *    moving, with no error. The guard that replaces it is that an unknown id
 *    matches no row, which only a row assertion can demonstrate.
 *  - the visibility/status predicate is on BOTH the eligibility read and the
 *    increment. A forged `postUri` for a private, followers-only or draft post
 *    must allocate no dedupe key and move no counter.
 *  - the RETURNED number is the post-increment total. Mongo needed `new: true`
 *    for that and a mock could only assert the option was passed; `RETURNING`
 *    gives the value the row actually holds, so the test compares the returned
 *    number against the stored one instead of against a mock's script.
 */
const mocks = vi.hoisted(() => ({ redisSet: vi.fn() }));

vi.mock('../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: true,
    isOpen: true,
    connect: vi.fn().mockResolvedValue(undefined),
    // Legacy client surface; ready hot paths execute the operation directly.
    ping: vi.fn().mockResolvedValue('PONG'),
    set: mocks.redisSet,
  }),
}));

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { deletePostRecord, insertPostRecord } from '../db/posts/postRepository';
import { isPostEligibleForViewTelemetry, recordDedupedView } from '../services/feedViewCounter';

const AUTHOR = 'oxy-view-author';
const created: string[] = [];

async function seed(
  overrides: { visibility?: PostVisibility; status?: 'draft' | 'published' | 'scheduled' } = {},
): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: overrides.visibility ?? PostVisibility.PUBLIC,
    status: overrides.status ?? 'published',
    ...(overrides.status === 'scheduled' ? { scheduledFor: new Date(Date.now() + 60_000) } : {}),
    content: { variants: [{ source: 'author', text: 'seen', tag: 'en' }] },
  });
  created.push(record.id);
  return record.id;
}

async function viewsCountOf(postId: string): Promise<number> {
  const [row] = await getDb()
    .select({ views: posts.statsViewsCount })
    .from(posts)
    .where(eq(posts.id, postId));
  return row?.views ?? -1;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisSet.mockResolvedValue('OK');
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id, undefined);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('feedViewCounter', () => {
  it('only treats public published posts as eligible for impression side effects', async () => {
    const publicPost = await seed();

    await expect(isPostEligibleForViewTelemetry(publicPost)).resolves.toBe(true);
  });

  it('accepts a uuid-v7 post id — the shape every post created since the cutover has', async () => {
    const postId = await seed();

    // The id the repository minted, not one the test invented: an ObjectId-shape
    // pre-check would reject it, and the failure would be silent.
    expect(postId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await expect(isPostEligibleForViewTelemetry(postId)).resolves.toBe(true);
  });

  it('does not allocate a Redis dedupe key or count for a nonexistent post', async () => {
    await expect(recordDedupedView('not-a-post-at-all', 'attacker_oxy_user')).resolves.toBeNull();

    expect(mocks.redisSet).not.toHaveBeenCalled();
  });

  it('treats private, followers-only, and draft posts as ineligible', async () => {
    const privatePost = await seed({ visibility: PostVisibility.PRIVATE });
    const followersOnly = await seed({ visibility: PostVisibility.FOLLOWERS_ONLY });
    const draft = await seed({ status: 'draft' });

    await expect(isPostEligibleForViewTelemetry(privatePost)).resolves.toBe(false);
    await expect(isPostEligibleForViewTelemetry(followersOnly)).resolves.toBe(false);
    await expect(isPostEligibleForViewTelemetry(draft)).resolves.toBe(false);

    await expect(recordDedupedView(followersOnly, 'attacker_oxy_user')).resolves.toBeNull();
    expect(mocks.redisSet).not.toHaveBeenCalled();
    expect(await viewsCountOf(followersOnly)).toBe(0);
  });

  it('increments the real counter for an eligible post, once the dedupe key is claimed', async () => {
    const postId = await seed();

    await expect(recordDedupedView(postId, 'viewer_oxy_user')).resolves.toBe(1);

    expect(mocks.redisSet).toHaveBeenCalledWith(`viewseen:${postId}:viewer_oxy_user`, '1', {
      NX: true,
      EX: expect.any(Number),
    });
    expect(await viewsCountOf(postId)).toBe(1);
  });

  it('returns the POST-increment total, not the value the row held before', async () => {
    // The distinction is invisible from a moving number alone: a pre-increment
    // answer still climbs, it is just always one view behind the view it reports
    // — the exact staleness this return value exists to remove. Comparing the
    // returned number against the STORED one after the write is what separates
    // them, and it needs a count above 1 to be able to differ at all.
    const postId = await seed();

    await recordDedupedView(postId, 'viewer_one');
    await recordDedupedView(postId, 'viewer_two');
    const returned = await recordDedupedView(postId, 'viewer_three');

    expect(returned).toBe(3);
    expect(returned).toBe(await viewsCountOf(postId));
  });

  it('reports no count when the dedupe window already claimed this viewer', async () => {
    // `SET … NX` answers null when the key exists — the second view of the same
    // (post, viewer) pair inside the window. It must neither increment nor report
    // a number, or a client would paint a "+1" the server never performed.
    const postId = await seed();
    mocks.redisSet.mockResolvedValue(null);

    await expect(recordDedupedView(postId, 'viewer_oxy_user')).resolves.toBeNull();

    expect(await viewsCountOf(postId)).toBe(0);
  });
});
