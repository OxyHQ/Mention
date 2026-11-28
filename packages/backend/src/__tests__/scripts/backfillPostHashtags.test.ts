/**
 * `backfillPostHashtags` copies exactly what the 0071 triggers would have
 * written for posts that predate them, and nothing else.
 *
 * The pre-migration state is staged by deleting the rows the triggers wrote for
 * fresh posts: the table then holds what production holds before the copy. The
 * copy must restore exactly those rows (the trigger's filter and columns), leave
 * an unlisted post out, count without writing on a dry run, and write nothing on
 * a second run. Runs on its own database (`isolatedDatabaseFiles.ts`): the copy
 * walks every post.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { postHashtags } from '../../db/schema/postContent';
import { insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';
import { backfillPostHashtags } from '../../scripts/backfillPostHashtags';

let db: Database;
const created: string[] = [];
const AUTHOR = 'oxy-hashtag-backfill-author';

async function seed(overrides: Partial<PostRecordInput>): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'hashtag backfill', tag: 'en' }] },
    ...overrides,
  });
  created.push(record.id);
  return record.id;
}

async function rowsOf(ids: readonly string[]) {
  return db
    .select({
      postId: postHashtags.postId,
      tag: postHashtags.tag,
      createdAt: postHashtags.createdAt,
    })
    .from(postHashtags)
    .where(inArray(postHashtags.postId, [...ids]))
    .orderBy(asc(postHashtags.postId), asc(postHashtags.tag));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  while (created.length > 0) {
    const id = created.pop();
    if (id) await db.delete(posts).where(eq(posts.id, id));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('backfillPostHashtags', () => {
  it('restores exactly the rows the triggers write, once', async () => {
    const listed = await seed({ hashtags: ['rust', 'wasm', 'rust'] });
    const alsoListed = await seed({ hashtags: ['zig'] });
    const untagged = await seed({});
    const privatePost = await seed({ hashtags: ['rust'], visibility: PostVisibility.PRIVATE });
    const collapsed = await seed({ hashtags: ['rust'] });
    await db.update(posts).set({ crosspostCollapsed: true }).where(eq(posts.id, collapsed));
    const all = [listed, alsoListed, untagged, privatePost, collapsed];

    // What the triggers wrote is the answer; deleting it stages the posts that
    // predate the triggers.
    const expected = await rowsOf(all);
    expect(expected.map((row) => `${row.postId}:${row.tag}`)).toEqual(
      [`${listed}:rust`, `${listed}:wasm`, `${alsoListed}:zig`].sort(),
    );
    await db.delete(postHashtags).where(inArray(postHashtags.postId, all));

    const dryRun = await backfillPostHashtags({ dryRun: true, pauseMs: 0 });
    expect(dryRun.postsListed).toBe(2);
    expect(dryRun.rowsWritten).toBe(0);
    expect(await rowsOf(all)).toEqual([]);

    const live = await backfillPostHashtags({ dryRun: false, pauseMs: 0 });
    expect(live.postsListed).toBe(2);
    expect(live.rowsWritten).toBe(3);
    expect(await rowsOf(all)).toEqual(expected);

    const again = await backfillPostHashtags({ dryRun: false, pauseMs: 0 });
    expect(again.rowsWritten).toBe(0);
    expect(await rowsOf(all)).toEqual(expected);
  });
});
