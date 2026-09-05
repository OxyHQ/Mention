import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * A federated reply COUNTS on its parent, and stops counting when deleted.
 *
 * ## What was broken
 *
 * `bumpPostCounters(..., { comments: 1 })` had exactly ONE caller — the NATIVE
 * reply path. A federated boost has always been counted (the outbox side bumps
 * `{ boosts: 1, federatedBoosts: 1 }`), so replies were the single federated
 * engagement that silently did not exist. And `comments: -1` appeared nowhere at
 * all, so even native counts only ever went up.
 *
 * Measured on production 2026-09-05: of 50 For You posts, **22 carried
 * `recentReplierAvatars` beside a reply count of zero**. Those avatars come from
 * a REAL query over reply rows, so the rows existed and the counter did not know.
 *
 * ## Why it is a RANKING bug, not just a display one
 *
 * `engagementScoreSql` weights `commentsCount` at `commentWeight` (2.0) — the
 * second-highest weight it has. On a corpus that is essentially all federated,
 * that term was structurally zero, so the strongest quality signal available
 * (people are actually replying to this) contributed nothing and ranking was left
 * leaning on federated boosts and recency.
 */

import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { deletePostRecord, insertPostRecord, loadPostRecord } from '../db/posts/postRepository';
import { PostType, PostVisibility } from '@mention/shared-types';
import type { PostRecordInput } from '../db/posts/postRecord';

const AUTHOR = 'fed-reply-counts-author';
const created: string[] = [];

async function seed(overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'body' }] },
    ...overrides,
  });
  created.push(record.id);
  return record.id;
}

/** The denormalized counter the DTO and `engagementScoreSql` both read. */
async function commentsOf(postId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: posts.statsCommentsCount })
    .from(posts)
    .where(eq(posts.id, postId));
  return row?.n ?? 0;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  const ids = created.splice(0);
  if (ids.length > 0) {
    for (const id of ids) {
      await getDb().delete(posts).where(eq(posts.id, id));
    }
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('reply counts on the parent', () => {
  it('a deleted reply stops counting on its parent', async () => {
    const parent = await seed();
    const reply = await seed({ isReply: true, parentPostId: parent });
    await getDb().update(posts).set({ statsCommentsCount: 1 }).where(eq(posts.id, parent));

    // Vacuity floor: the counter really was 1 before the delete, so the
    // assertion below is about the delete and not about a counter that was
    // already zero.
    expect(await commentsOf(parent)).toBe(1);

    await deletePostRecord(reply, undefined);

    expect(await commentsOf(parent)).toBe(0);
  });

  /**
   * The clamp matters: a redelivered Delete, or a reply whose parent was never
   * counted in the first place (every federated reply before this change), must
   * not drive the counter negative and make the post look like it owes replies.
   */
  it('never drives the parent count below zero', async () => {
    const parent = await seed();
    const reply = await seed({ isReply: true, parentPostId: parent });
    expect(await commentsOf(parent)).toBe(0);

    await deletePostRecord(reply, undefined);

    expect(await commentsOf(parent)).toBe(0);
  });

  /**
   * SCOPE. Deleting a ROOT decrements nothing.
   *
   * Written first as "a post with a parentPostId but isReply:false must not
   * decrement", which turned out to be unconstructible: `insertPostRecord` runs
   * `derivesReplyIntent`, which ORs the local link and the federated IRI into the
   * one stored `is_reply` column at write time — so a row carrying a parent IS a
   * reply, and the two halves of the guard cannot disagree. The real scope
   * question is the one below.
   */
  it('does not touch any counter when the deleted post is a root', async () => {
    const parent = await seed();
    const unrelatedRoot = await seed();
    await getDb().update(posts).set({ statsCommentsCount: 5 }).where(eq(posts.id, parent));

    await deletePostRecord(unrelatedRoot, undefined);

    expect(await commentsOf(parent)).toBe(5);
  });

  it('leaves the parent alone when the delete matched nothing', async () => {
    const parent = await seed();
    const reply = await seed({ isReply: true, parentPostId: parent });
    await getDb().update(posts).set({ statsCommentsCount: 3 }).where(eq(posts.id, parent));

    // A `where` the row cannot satisfy — the ownership guard every caller passes.
    const result = await deletePostRecord(reply, and(eq(posts.oxyUserId, 'somebody-else')));

    expect(result).toBeNull();
    expect(await commentsOf(parent)).toBe(3);
    expect(await loadPostRecord(reply)).not.toBeNull();
  });
});
