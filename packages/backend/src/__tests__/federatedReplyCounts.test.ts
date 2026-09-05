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
import { deletePostRecord, loadPostRecord } from '../db/posts/postRepository';
import { clearServiceScope, seedPost, serviceScope } from './helpers/serviceFixtures';
import type { PostRecordInput } from '../db/posts/postRecord';

// The shared harness, not a hand-rolled one: `serviceScope` namespaces every id
// per file because vitest runs files in parallel against ONE database, and
// `clearServiceScope` wraps its deletes in `withDeadlockRetry` for the same
// reason. A local `const created: string[]` plus a bare delete loop opts out of
// both.
const scope = serviceScope('federated-reply-counts');

async function seed(overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const record = await seedPost(scope, overrides);
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
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('reply counts on the parent', () => {
  /**
   * The increment, from the ONE place that now owns it.
   *
   * It used to be hand-wired in the callers, and only two of the five reply
   * paths did it — `PostCreationService` (`POST /posts`, threads) and
   * `PostMaterializer` (atproto) both write `parentPostId` and neither bumped.
   * `insertPostRecord` derives `isReply` itself, so putting it there is what makes
   * "a reply moves its parent's count" true of every path, including ones not
   * written yet. This exercises `seedPost` → `insertPostRecord`, which is none of
   * the five.
   */
  it('a created reply counts on its parent, whatever path created it', async () => {
    const parent = await seed();
    expect(await commentsOf(parent)).toBe(0);

    await seed({ isReply: true, parentPostId: parent });

    expect(await commentsOf(parent)).toBe(1);
  });

  it('counts each reply once', async () => {
    const parent = await seed();
    await seed({ isReply: true, parentPostId: parent });
    await seed({ isReply: true, parentPostId: parent });

    expect(await commentsOf(parent)).toBe(2);
  });

  it('a root does not count on anything', async () => {
    const parent = await seed();
    await seed();

    expect(await commentsOf(parent)).toBe(0);
  });

  it('a deleted reply stops counting on its parent', async () => {
    const parent = await seed();
    const reply = await seed({ isReply: true, parentPostId: parent });

    // Vacuity floor: the counter really was 1 before the delete, so the
    // assertion below is about the delete and not about a counter that was
    // already zero. It gets there through the insert, which is the pair being
    // tested.
    expect(await commentsOf(parent)).toBe(1);

    await deletePostRecord(reply, undefined);

    expect(await commentsOf(parent)).toBe(0);
  });

  /**
   * The clamp matters, and the state it protects is REAL rather than
   * hypothetical: every federated reply written before the increment existed sits
   * on a parent whose counter never saw it. Deleting one of those must not drive
   * the count negative and make the post look like it owes replies.
   *
   * The counter is forced to zero to reconstruct exactly that history — the
   * insert now counts, so this is the one case that cannot be reached by creating
   * a reply normally.
   */
  it('never drives the parent count below zero', async () => {
    const parent = await seed();
    const reply = await seed({ isReply: true, parentPostId: parent });
    await getDb().update(posts).set({ statsCommentsCount: 0 }).where(eq(posts.id, parent));
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
    await seed({ isReply: true, parentPostId: parent });
    const unrelatedRoot = await seed();
    expect(await commentsOf(parent)).toBe(1);

    await deletePostRecord(unrelatedRoot, undefined);

    expect(await commentsOf(parent)).toBe(1);
  });

  it('leaves the parent alone when the delete matched nothing', async () => {
    const parent = await seed();
    const reply = await seed({ isReply: true, parentPostId: parent });
    expect(await commentsOf(parent)).toBe(1);

    // A `where` the row cannot satisfy — the ownership guard every caller passes.
    const result = await deletePostRecord(reply, and(eq(posts.oxyUserId, 'somebody-else')));

    expect(result).toBeNull();
    expect(await commentsOf(parent)).toBe(1);
    expect(await loadPostRecord(reply)).not.toBeNull();
  });
});
