/**
 * `post_hashtags` follows `posts` in the writing transaction.
 *
 * The table is maintained by the `posts_hashtags_*` triggers (migration 0071),
 * so every way a post can start or stop being listed under a tag is asserted
 * here against real rows: tagging, re-tagging, visibility, status, crosspost
 * collapse, re-dating and deletion. The failure this guards is silent — a post
 * made private that stays on a public hashtag page, or a tag that never shows
 * a post — so each case reads the table directly.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { asc, eq, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { postHashtags } from '../../db/schema/postContent';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';

let db: Database;
const created: string[] = [];
const AUTHOR = 'oxy-hashtag-sync-author';

async function create(overrides: Partial<PostRecordInput> = {}) {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'hashtag fixture', tag: 'en' }] },
    ...overrides,
  });
  created.push(record.id);
  return record;
}

async function tagsOf(postId: string): Promise<string[]> {
  const rows = await db
    .select({ tag: postHashtags.tag })
    .from(postHashtags)
    .where(eq(postHashtags.postId, postId))
    .orderBy(asc(postHashtags.tag));
  return rows.map((row) => row.tag);
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

describe('post_hashtags', () => {
  it('lists a public post under each distinct tag, with its created_at', async () => {
    const post = await create({ hashtags: ['rust', 'wasm', 'rust'] });

    expect(await tagsOf(post.id)).toEqual(['rust', 'wasm']);
    const [row] = await db
      .select({ createdAt: postHashtags.createdAt })
      .from(postHashtags)
      .where(eq(postHashtags.postId, post.id))
      .limit(1);
    expect(row?.createdAt.getTime()).toBe(post.createdAt.getTime());
  });

  it('follows a re-tag, including to no tags at all', async () => {
    const post = await create({ hashtags: ['rust'] });

    await db
      .update(posts)
      .set({ hashtags: ['zig', 'wasm'] })
      .where(eq(posts.id, post.id));
    expect(await tagsOf(post.id)).toEqual(['wasm', 'zig']);

    await db.update(posts).set({ hashtags: [] }).where(eq(posts.id, post.id));
    expect(await tagsOf(post.id)).toEqual([]);
  });

  it('drops a post that stops being listed, and lists it again when it is', async () => {
    const post = await create({ hashtags: ['rust'] });

    await db.update(posts).set({ visibility: PostVisibility.PRIVATE }).where(eq(posts.id, post.id));
    expect(await tagsOf(post.id)).toEqual([]);

    await db.update(posts).set({ visibility: PostVisibility.PUBLIC }).where(eq(posts.id, post.id));
    expect(await tagsOf(post.id)).toEqual(['rust']);

    await db.update(posts).set({ status: 'draft' }).where(eq(posts.id, post.id));
    expect(await tagsOf(post.id)).toEqual([]);

    await db.update(posts).set({ status: 'published' }).where(eq(posts.id, post.id));
    await db.update(posts).set({ crosspostCollapsed: true }).where(eq(posts.id, post.id));
    expect(await tagsOf(post.id)).toEqual([]);
  });

  it('never lists a post written private', async () => {
    const post = await create({ hashtags: ['rust'], visibility: PostVisibility.PRIVATE });

    expect(await tagsOf(post.id)).toEqual([]);
  });

  it('moves the rows with a re-dated post', async () => {
    const post = await create({ hashtags: ['rust'] });

    await db
      .update(posts)
      .set({ createdAt: sql`date_trunc('milliseconds', now() - interval '3 days')` })
      .where(eq(posts.id, post.id));

    const [stored] = await db
      .select({ createdAt: posts.createdAt })
      .from(posts)
      .where(eq(posts.id, post.id));
    const [row] = await db
      .select({ createdAt: postHashtags.createdAt })
      .from(postHashtags)
      .where(eq(postHashtags.postId, post.id));
    expect(row?.createdAt.getTime()).toBe(stored?.createdAt.getTime());
  });

  it('leaves the rows alone when an unrelated column changes', async () => {
    const post = await create({ hashtags: ['rust'] });
    // A value the trigger would never write, so a trigger that fired on these
    // writes would be seen rewriting it.
    await db.update(postHashtags).set({ tag: 'sentinel' }).where(eq(postHashtags.postId, post.id));

    await db.update(posts).set({ statsLikesCount: 4 }).where(eq(posts.id, post.id));
    await db
      .update(posts)
      .set({ visibility: PostVisibility.PUBLIC, status: 'published' })
      .where(eq(posts.id, post.id));

    expect(await tagsOf(post.id)).toEqual(['sentinel']);
  });

  it('loses the rows with the post', async () => {
    const post = await create({ hashtags: ['rust'] });

    await deletePostRecord(post.id);
    created.splice(created.indexOf(post.id), 1);

    expect(await tagsOf(post.id)).toEqual([]);
  });
});
