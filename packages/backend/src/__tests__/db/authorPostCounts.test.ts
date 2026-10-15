/**
 * `author_post_counts` follows `posts` in the writing transaction.
 *
 * The counts are maintained by the `posts_author_counts_*` triggers (migration
 * 0068) rather than computed per profile view, so the failure this file guards
 * is drift: a path that moves a post into or out of the counted set without the
 * row following it, after which the profile shows a wrong number forever and
 * nothing errors. Every case therefore checks the stored row against what the
 * old per-request count over `posts` returns for the same author — the
 * definition the row has to keep matching — as well as against literal numbers.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { authorPostCounts, posts } from '../../db/schema/posts';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { countAuthorPublicPosts } from '../../db/posts/authorPostCounts';

let db: Database;
const created: string[] = [];
let authorSeq = 0;

/** A fresh author per case, so no two cases share a counter row. */
function newAuthor(): string {
  authorSeq += 1;
  return `oxy-counts-${process.pid}-${Date.now()}-${authorSeq}`;
}

async function create(author: string, overrides: Partial<PostRecordInput> = {}) {
  const record = await insertPostRecord({
    oxyUserId: author,
    authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'count fixture', tag: 'en' }] },
    ...overrides,
  });
  created.push(record.id);
  return record;
}

/** The definition the row must match: the per-request count this table replaced. */
async function countedFromPosts(author: string) {
  const [row] = await db
    .select({
      postsCount: sql<number>`count(*) filter (where ${posts.isReply} = false)::int`,
      boostsCount: sql<number>`count(*) filter (where ${posts.type} = ${PostType.BOOST})::int`,
      repliesCount: sql<number>`count(*) filter (where ${posts.isReply})::int`,
    })
    .from(posts)
    .where(
      and(
        eq(posts.oxyUserId, author),
        eq(posts.visibility, PostVisibility.PUBLIC),
        eq(posts.status, 'published'),
        sql`${posts.crosspostCollapsed} is not true`,
      ),
    );
  return row;
}

async function expectCounts(
  author: string,
  expected: { postsCount: number; repliesCount: number; boostsCount: number },
) {
  const stored = await countAuthorPublicPosts(author);
  expect(stored).toEqual(expected);
  expect(stored).toEqual(await countedFromPosts(author));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('author_post_counts', () => {
  it('reads zero for an author with no counted post', async () => {
    await expectCounts(newAuthor(), { postsCount: 0, repliesCount: 0, boostsCount: 0 });
  });

  it('counts posts, replies and boosts as they are written', async () => {
    const author = newAuthor();
    const root = await create(author);
    await create(author, { parentPostId: root.id });
    await create(author, { type: PostType.BOOST, boostOf: root.id });

    await expectCounts(author, { postsCount: 2, repliesCount: 1, boostsCount: 1 });
  });

  it('never counts a private, unpublished or collapsed post', async () => {
    const author = newAuthor();
    await create(author, { visibility: PostVisibility.PRIVATE });
    await create(author, { status: 'draft' });
    const collapsed = await create(author);
    await db.update(posts).set({ crosspostCollapsed: true }).where(eq(posts.id, collapsed.id));

    await expectCounts(author, { postsCount: 0, repliesCount: 0, boostsCount: 0 });
  });

  it('follows a post out of the counted set and back in', async () => {
    const author = newAuthor();
    const post = await create(author);

    await db.update(posts).set({ visibility: PostVisibility.PRIVATE }).where(eq(posts.id, post.id));
    await expectCounts(author, { postsCount: 0, repliesCount: 0, boostsCount: 0 });

    await db.update(posts).set({ visibility: PostVisibility.PUBLIC }).where(eq(posts.id, post.id));
    await expectCounts(author, { postsCount: 1, repliesCount: 0, boostsCount: 0 });

    await db.update(posts).set({ status: 'draft' }).where(eq(posts.id, post.id));
    await expectCounts(author, { postsCount: 0, repliesCount: 0, boostsCount: 0 });

    await db.update(posts).set({ status: 'published' }).where(eq(posts.id, post.id));
    await db.update(posts).set({ crosspostCollapsed: true }).where(eq(posts.id, post.id));
    await expectCounts(author, { postsCount: 0, repliesCount: 0, boostsCount: 0 });

    await db.update(posts).set({ crosspostCollapsed: false }).where(eq(posts.id, post.id));
    await expectCounts(author, { postsCount: 1, repliesCount: 0, boostsCount: 0 });
  });

  it('moves a post between buckets when its stored discriminators change', async () => {
    const author = newAuthor();
    const post = await create(author);

    await db.update(posts).set({ isReply: true }).where(eq(posts.id, post.id));
    await expectCounts(author, { postsCount: 0, repliesCount: 1, boostsCount: 0 });

    await db.update(posts).set({ type: PostType.BOOST }).where(eq(posts.id, post.id));
    await expectCounts(author, { postsCount: 0, repliesCount: 1, boostsCount: 1 });
  });

  it('moves the counts to the new author when a post is re-authored', async () => {
    const before = newAuthor();
    const after = newAuthor();
    const kept = await create(before);
    const moved = await create(before, { parentPostId: kept.id });

    // The identity projection moves posts with a raw UPDATE of `oxy_user_id`.
    await db.update(posts).set({ oxyUserId: after }).where(eq(posts.id, moved.id));

    await expectCounts(before, { postsCount: 1, repliesCount: 0, boostsCount: 0 });
    await expectCounts(after, { postsCount: 0, repliesCount: 1, boostsCount: 0 });
  });

  it("subtracts a deleted post, including another author's boost the delete cascades to", async () => {
    const author = newAuthor();
    const booster = newAuthor();
    const original = await create(author);
    await create(booster, { type: PostType.BOOST, boostOf: original.id });
    await expectCounts(booster, { postsCount: 1, repliesCount: 0, boostsCount: 1 });

    await deletePostRecord(original.id);

    await expectCounts(author, { postsCount: 0, repliesCount: 0, boostsCount: 0 });
    await expectCounts(booster, { postsCount: 0, repliesCount: 0, boostsCount: 0 });
  });

  it('leaves the counts alone when a write repeats the counted columns unchanged', async () => {
    const author = newAuthor();
    const post = await create(author);
    // Plant a value the triggers would never produce, so a trigger that fired on
    // these writes and recounted or re-applied a delta would be seen.
    await db
      .update(authorPostCounts)
      .set({ postsCount: 7 })
      .where(eq(authorPostCounts.oxyUserId, author));

    await db.update(posts).set({ statsLikesCount: 3 }).where(eq(posts.id, post.id));
    await db
      .update(posts)
      .set({ visibility: PostVisibility.PUBLIC, status: 'published', oxyUserId: author })
      .where(eq(posts.id, post.id));

    expect((await countAuthorPublicPosts(author)).postsCount).toBe(7);
  });

  it('never recreates a row once it is gone, as account erasure leaves it', async () => {
    const author = newAuthor();
    const post = await create(author);
    // Erasure deletes the counter row after the posts walk; a subtraction that
    // arrives later must not write the account id back.
    await db.delete(authorPostCounts).where(eq(authorPostCounts.oxyUserId, author));

    await db.update(posts).set({ visibility: PostVisibility.PRIVATE }).where(eq(posts.id, post.id));

    const rows = await db
      .select()
      .from(authorPostCounts)
      .where(eq(authorPostCounts.oxyUserId, author));
    expect(rows).toEqual([]);
  });
});
