/**
 * `topic_affinity_posts` follows `posts` in the writing transaction.
 *
 * The table is maintained by the `posts_topic_affinity_*` triggers (migration
 * 0067), not by a job, so every way a post can enter or leave the eligible set
 * is asserted here against real rows: classification, visibility, status, type,
 * authorship, age and deletion. Each case reads the table directly, because the
 * failure this guards is silent — a row that should have left keeps scoring an
 * author on the For You feed, and nothing errors.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { topicAffinityPosts } from '../../db/schema/discovery';
import { deletePostRecord, insertPostRecord } from '../../db/posts/postRepository';
import type { PostRecordInput } from '../../db/posts/postRecord';

let db: Database;
const created: string[] = [];

const AUTHOR = 'oxy-topic-sync-author';
const OTHER_AUTHOR = 'oxy-topic-sync-other';

async function create(overrides: Partial<PostRecordInput> = {}) {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'topic sync fixture', tag: 'en' }] },
    ...overrides,
  });
  created.push(record.id);
  return record;
}

async function rowFor(postId: string) {
  const [row] = await db
    .select()
    .from(topicAffinityPosts)
    .where(eq(topicAffinityPosts.postId, postId));
  return row;
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

describe('topic_affinity_posts', () => {
  it('holds an eligible post from the moment it is written', async () => {
    const post = await create({ postClassification: { topics: ['astronomy', 'optics'] } });

    const row = await rowFor(post.id);
    expect(row?.oxyUserId).toBe(AUTHOR);
    expect(row?.topics).toEqual(['astronomy', 'optics']);
    expect(row?.createdAt.getTime()).toBe(post.createdAt.getTime());
  });

  it('gains a post when classification gives it topics, and follows a reclassification', async () => {
    const post = await create();
    expect(await rowFor(post.id)).toBeUndefined();

    await db
      .update(posts)
      .set({ classificationTopics: ['geology'] })
      .where(eq(posts.id, post.id));
    expect((await rowFor(post.id))?.topics).toEqual(['geology']);

    await db
      .update(posts)
      .set({ classificationTopics: ['geology', 'volcanoes'] })
      .where(eq(posts.id, post.id));
    expect((await rowFor(post.id))?.topics).toEqual(['geology', 'volcanoes']);

    await db.update(posts).set({ classificationTopics: [] }).where(eq(posts.id, post.id));
    expect(await rowFor(post.id)).toBeUndefined();
  });

  it('drops a post that stops being public, and takes it back when it is public again', async () => {
    const post = await create({ postClassification: { topics: ['botany'] } });

    await db.update(posts).set({ visibility: PostVisibility.PRIVATE }).where(eq(posts.id, post.id));
    expect(await rowFor(post.id)).toBeUndefined();

    await db.update(posts).set({ visibility: PostVisibility.PUBLIC }).where(eq(posts.id, post.id));
    expect((await rowFor(post.id))?.topics).toEqual(['botany']);
  });

  it('drops a post that stops being published', async () => {
    const post = await create({ postClassification: { topics: ['botany'] } });

    await db.update(posts).set({ status: 'draft' }).where(eq(posts.id, post.id));

    expect(await rowFor(post.id)).toBeUndefined();
  });

  it('never holds a boost, a post without an author, or a post older than the window', async () => {
    const boost = await create({
      type: PostType.BOOST,
      postClassification: { topics: ['botany'] },
    });
    const orphan = await create({ postClassification: { topics: ['botany'] } });
    await db.update(posts).set({ oxyUserId: null }).where(eq(posts.id, orphan.id));
    const old = await create({ postClassification: { topics: ['botany'] } });
    await db
      .update(posts)
      .set({ createdAt: sql`date_trunc('milliseconds', now() - interval '31 days')` })
      .where(eq(posts.id, old.id));

    const rows = await db
      .select({ postId: topicAffinityPosts.postId })
      .from(topicAffinityPosts)
      .where(inArray(topicAffinityPosts.postId, [boost.id, orphan.id, old.id]));
    expect(rows).toEqual([]);
  });

  it('moves a post to its new author when the post is re-authored', async () => {
    const post = await create({ postClassification: { topics: ['botany'] } });

    await db.update(posts).set({ oxyUserId: OTHER_AUTHOR }).where(eq(posts.id, post.id));

    expect((await rowFor(post.id))?.oxyUserId).toBe(OTHER_AUTHOR);
  });

  it('leaves the row alone when an unrelated column changes', async () => {
    const post = await create({ postClassification: { topics: ['botany'] } });
    // Make the stored row distinguishable from what the trigger would write, so
    // a trigger that fired on this update would be seen putting it back.
    await db
      .update(topicAffinityPosts)
      .set({ topics: ['sentinel'] })
      .where(eq(topicAffinityPosts.postId, post.id));

    await db.update(posts).set({ statsLikesCount: 3 }).where(eq(posts.id, post.id));
    // A whole-row write repeats eligibility columns without changing them.
    await db
      .update(posts)
      .set({ visibility: PostVisibility.PUBLIC, status: 'published' })
      .where(eq(posts.id, post.id));

    expect((await rowFor(post.id))?.topics).toEqual(['sentinel']);
  });

  it('loses the row with the post', async () => {
    const post = await create({ postClassification: { topics: ['botany'] } });
    expect(await rowFor(post.id)).toBeDefined();

    await deletePostRecord(post.id);
    created.splice(created.indexOf(post.id), 1);

    expect(await rowFor(post.id)).toBeUndefined();
  });
});
