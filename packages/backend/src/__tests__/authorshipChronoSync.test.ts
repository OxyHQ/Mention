/**
 * `post_authorships.post_created_at` — the denormalized copy of
 * `posts.created_at` that `post_authorships_author_chrono_idx` orders by, and
 * the two things that have to stay true for it to be safe.
 *
 * **This is the invariant test the `or`-form deliberately did NOT need.** That
 * shape was a superset of both its terms, so it was correct whether or not the
 * denormalized owner agreed with the authorship row — asserting the agreement
 * would have failed on a data condition the code existed to tolerate. This one
 * is different in kind: the profile feed now ORDERS BY a copied timestamp, so a
 * copy that disagrees with its source does not degrade the feed, it silently
 * puts a post in the wrong place on someone's profile — or below the page
 * boundary, where it reads as the post being missing. The invariant became
 * load-bearing, so here is the test.
 *
 * Two properties, and they fail differently:
 *
 *  1. **The copy agrees**, at every path that writes an authorship row. Checked
 *     against `posts.created_at` itself rather than against the value the test
 *     passed in, so a writer that stores a plausible-but-wrong timestamp fails.
 *  2. **The decomposition agrees with the specification.** `authorFeedSql` is
 *     one expression saying what "this author's post" means; `fetchAuthored` is
 *     two index-served branches and a `union`. They must select the same rows —
 *     including over the drift shapes where the two branches disagree with each
 *     other, which is the only place the `union` earns its keep.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { postAuthorships, posts } from '../db/schema';
import { insertPostRecord, replacePostAuthorship } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { authorFeedSql } from '../utils/postAuthorship';
import { fetchAuthored } from '../mtn/feed/engine/sources/userSources';

let db: Database;
const created: string[] = [];

const AUTHOR = 'chronosync-author';
const OTHER = 'chronosync-other';

/** Future-stamped so this suite's rows sort above whatever else the shared database holds. */
const HORIZON = Date.now() + 60_000;

async function create(overrides: Partial<PostRecordInput>): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OTHER,
    authorship: [{ oxyUserId: OTHER, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'body' }] },
    createdAt: new Date(HORIZON),
    ...overrides,
  });
  created.push(record.id);
  return record.id;
}

/**
 * Authorship rows whose copied timestamp does NOT equal the post's own, for this
 * suite's posts. Compared in SQL against the source column so the assertion
 * cannot be satisfied by the test's own idea of the value.
 */
async function disagreeingRows(): Promise<Array<{ postId: string; oxyUserId: string }>> {
  if (created.length === 0) return [];
  return db
    .select({ postId: postAuthorships.postId, oxyUserId: postAuthorships.oxyUserId })
    .from(postAuthorships)
    .innerJoin(posts, eq(posts.id, postAuthorships.postId))
    .where(
      and(
        inArray(postAuthorships.postId, [...created]),
        sql`${postAuthorships.postCreatedAt} is distinct from ${posts.createdAt}`,
      ),
    );
}

/** What the SPECIFICATION predicate matches, restricted to this suite's rows. */
async function specMatches(authorId: string): Promise<string[]> {
  if (created.length === 0) return [];
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(authorFeedSql(authorId), inArray(posts.id, [...created])));
  return rows.map((row) => row.id).sort();
}

/** What the two-branch fast path returns, restricted to this suite's rows. */
async function fastPath(authorId: string): Promise<string[]> {
  const records = await fetchAuthored(
    authorId,
    [eq(posts.visibility, PostVisibility.PUBLIC), eq(posts.status, 'published')],
    undefined,
    100,
  );
  return records
    .map((record) => record.id)
    .filter((id) => created.includes(id))
    .sort();
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  const ids = created.splice(0);
  if (ids.length > 0) await db.delete(posts).where(inArray(posts.id, ids));
});

afterAll(async () => {
  await closePostgres();
});

describe('post_authorships.post_created_at stays equal to posts.created_at', () => {
  /**
   * The insert path. Every authorship row a post is created with — owner and
   * collaborators, whatever their status — carries the post's own timestamp.
   *
   * Mutation: have `insertChildRows` write `new Date()` instead of reading the
   * value back out of `posts`, and this goes red. It would not go red against an
   * assertion comparing to the timestamp the test supplied, because a writer
   * using "now" produces something very close to it.
   */
  it('is written by the insert path, for every authorship row', async () => {
    await create({
      oxyUserId: AUTHOR,
      createdAt: new Date(HORIZON - 5_000),
      authorship: [
        { oxyUserId: AUTHOR, role: 'owner', status: 'accepted' },
        { oxyUserId: OTHER, role: 'collaborator', status: 'pending' },
      ],
    });

    expect(await disagreeingRows()).toEqual([]);
  });

  /**
   * The replace path. `replacePostAuthorship` deletes and re-inserts the whole
   * list, so it is a second, independent writer of the same column — and the one
   * a collaborator accepting an invite goes through, long after the post was
   * created. A copy written from "now" here would be wrong by exactly the age of
   * the post.
   */
  it('is written by replacePostAuthorship, long after the post was created', async () => {
    const postId = await create({
      oxyUserId: AUTHOR,
      createdAt: new Date(HORIZON - 90_000),
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    });

    await replacePostAuthorship(postId, [
      { oxyUserId: AUTHOR, role: 'owner', status: 'accepted' },
      { oxyUserId: OTHER, role: 'collaborator', status: 'accepted' },
    ]);

    expect(await disagreeingRows()).toEqual([]);
  });
});

describe('fetchAuthored selects exactly what authorFeedSql specifies', () => {
  /**
   * The shapes where the two branches disagree with each other, which is the
   * whole reason there are two. Each row here is reachable down ONE branch only:
   *
   *   ordinary       both branches
   *   noAuthorship   the owner column only — no `post_authorships` row exists
   *   nullMirror     the authorship branch only — `oxy_user_id` was never written
   *   collab         the authorship branch only — owned by somebody else
   *
   * Mutation: drop either branch from `fetchAuthored` and this goes red naming
   * the rows that branch was the only route to.
   */
  it('agrees with the specification across every drift shape', async () => {
    const ordinary = await create({
      oxyUserId: AUTHOR,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    });
    const noAuthorship = await create({ oxyUserId: AUTHOR, authorship: [] });
    const nullMirror = await create({
      oxyUserId: null,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    });
    const collab = await create({
      oxyUserId: OTHER,
      authorship: [
        { oxyUserId: OTHER, role: 'owner', status: 'accepted' },
        { oxyUserId: AUTHOR, role: 'collaborator', status: 'accepted' },
      ],
    });
    // Withheld: a pending invite is not authorship, down either route.
    await create({
      oxyUserId: OTHER,
      authorship: [
        { oxyUserId: OTHER, role: 'owner', status: 'accepted' },
        { oxyUserId: AUTHOR, role: 'collaborator', status: 'pending' },
      ],
    });

    const expected = [ordinary, noAuthorship, nullMirror, collab].sort();
    expect(await specMatches(AUTHOR)).toEqual(expected);
    expect(await fastPath(AUTHOR)).toEqual(expected);
  });

  /**
   * A post reachable down BOTH branches must be served ONCE. `union all` returns
   * it twice and the page limit is then spent on duplicates — measured at
   * production scale, a page of 21 came back holding 12 distinct posts.
   *
   * Mutation: swap `union` for `unionAll` in `fetchAuthored` and this goes red on
   * the length.
   */
  it('serves a post reachable down both branches exactly once', async () => {
    const both = await create({
      oxyUserId: AUTHOR,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    });

    const served = await fastPath(AUTHOR);
    expect(served).toEqual([both]);
  });

  /**
   * Newest first, across both branches. The branches are ordered by DIFFERENT
   * columns — the owner branch by `posts.created_at`, the authorship branch by
   * the copy — so an interleaved result is the only thing that shows the merge
   * ordering the two together rather than concatenating them.
   */
  it('returns both branches interleaved in chronological order', async () => {
    const newestOwner = await create({
      oxyUserId: AUTHOR,
      createdAt: new Date(HORIZON),
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    });
    const middleCollab = await create({
      oxyUserId: OTHER,
      createdAt: new Date(HORIZON - 10_000),
      authorship: [
        { oxyUserId: OTHER, role: 'owner', status: 'accepted' },
        { oxyUserId: AUTHOR, role: 'collaborator', status: 'accepted' },
      ],
    });
    const oldestOwner = await create({
      oxyUserId: AUTHOR,
      createdAt: new Date(HORIZON - 20_000),
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    });

    const records = await fetchAuthored(
      AUTHOR,
      [eq(posts.visibility, PostVisibility.PUBLIC), eq(posts.status, 'published')],
      undefined,
      100,
    );
    const ordered = records.map((r) => r.id).filter((id) => created.includes(id));

    expect(ordered).toEqual([newestOwner, middleCollab, oldestOwner]);
  });
});
