import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * The profile-design post counts, against REAL ROWS.
 *
 * The previous version stubbed `Post.countDocuments` and asserted the three
 * FILTER OBJECTS the route passed. That could not distinguish a correct
 * predicate from one matching nothing (every count reads zero, which looks like
 * a new account) — and it could not have caught the change that actually
 * mattered here: the reply/root split now reads the STORED `is_reply`
 * discriminator instead of `parent_post_id IS NULL`, because `ON DELETE SET
 * NULL` clears a parent link without making the reply a root post.
 *
 * The three guarantees, each failing in its own direction: a root counts once as
 * a post and never as a reply, a boost counts as a boost, and nothing private or
 * unpublished is counted at all.
 */
const { findOne } = vi.hoisted(() => ({ findOne: vi.fn() }));

// Keep the runtime-client seam deterministic while importing the route in
// isolation. No live Oxy client should be constructed by this unit test.
vi.mock('../../runtime/oxyClient', () => ({ getRuntimeOxyClient: () => ({}) }));

// Mock privacyHelpers directly: this route test only needs the visibility
// contract, not the helper's Oxy graph dependencies. The two exports the route
// uses are reproduced faithfully; the gate resolves to "visible" so the counts
// below are what the assertions are actually about. The gate's own behaviour is
// covered by `profileDesignVisibilityParity.test.ts`.
vi.mock('../../utils/privacyHelpers', () => ({
  ProfileVisibility: {
    PUBLIC: 'public',
    PRIVATE: 'private',
    FOLLOWERS_ONLY: 'followers_only',
  },
  canViewProfileDesign: vi.fn().mockResolvedValue(true),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import profileDesignRoutes from '../../routes/profileDesign';

const app = express();
app.use('/profile/design', profileDesignRoutes);

const AUTHOR = 'user-1';
const OTHER = 'user-2';
const created: string[] = [];

async function seed(overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const owner = overrides.oxyUserId ?? AUTHOR;
  const record = await insertPostRecord({
    oxyUserId: owner,
    authorship: [{ oxyUserId: owner as string, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'hello', tag: 'en' }] },
    ...overrides,
  });
  created.push(record.id);
  return record.id;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id, undefined);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('profile design public counts', () => {
  it('counts only published public posts, boosts, and replies of THIS author', async () => {
    const root = await seed();
    await seed({ parentPostId: root });
    await seed({ type: PostType.BOOST, boostOf: root, content: {} });
    // Excluded: not public, not published, or not this author.
    await seed({ visibility: PostVisibility.PRIVATE });
    await seed({ status: 'draft' });
    await seed({ oxyUserId: OTHER });

    const response = await request(app).get(`/profile/design/${AUTHOR}`).expect(200);

    // The root and the boost are both non-replies; the reply is counted once.
    expect(response.body.data.postsCount).toBe(2);
    expect(response.body.data.boostsCount).toBe(1);
    expect(response.body.data.repliesCount).toBe(1);
  });

  it('counts an ORPHANED reply as a reply, not as a top-level post', async () => {
    const parent = await seed();
    const reply = await seed({ parentPostId: parent });

    // Deleting the parent fires `ON DELETE SET NULL`, so the reply's parent link
    // is gone while `is_reply` stays true. A count keyed on `parent_post_id IS
    // NULL` would now report this reply as one of the author's top-level posts.
    await deletePostRecord(parent, undefined);
    created.splice(created.indexOf(parent), 1);

    const response = await request(app).get(`/profile/design/${AUTHOR}`).expect(200);

    expect(response.body.data.postsCount).toBe(0);
    expect(response.body.data.repliesCount).toBe(1);
    expect(created).toContain(reply);
  });
});
