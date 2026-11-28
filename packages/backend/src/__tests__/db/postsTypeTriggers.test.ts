/**
 * The per-author counters and the topic-affinity index only care whether a post IS a repost, not
 * which of its two stored names it carries (docs/repost-rename.md), so renaming 'boost' to 'repost'
 * must neither fire their triggers nor move a counter, while becoming or ceasing to be a repost
 * still does.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { insertPostRecord } from '../../db/posts/postRepository';
import { authorPostCounts, posts } from '../../db/schema/posts';

let db: Database;
const created: string[] = [];
const AUTHOR = `type-trg-${process.pid}-${Date.now()}`;

const counts = async () =>
  (await db.select().from(authorPostCounts).where(eq(authorPostCounts.oxyUserId, AUTHOR)))[0];

beforeAll(async () => {
  db = await connectPostgres();
});
afterEach(async () => {
  if (created.length > 0) await db.delete(posts).where(inArray(posts.id, created));
  created.length = 0;
  await db.delete(authorPostCounts).where(eq(authorPostCounts.oxyUserId, AUTHOR));
});
afterAll(async () => {
  await closePostgres();
});

describe('posts type triggers and the repost rename', () => {
  it('counts becoming and ceasing to be a repost, and leaves the counter alone on boost <-> repost', async () => {
    const record = await insertPostRecord({
      oxyUserId: AUTHOR,
      authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'trigger fixture' }] },
    });
    created.push(record.id);
    expect(await counts()).toMatchObject({ postsCount: 1, repostsCount: 0 });

    const setType = (type: string) =>
      db.execute(sql`update posts set type = ${type} where id = ${record.id}`);
    await setType('boost');
    expect(await counts()).toMatchObject({ postsCount: 1, repostsCount: 1 });
    await setType('repost');
    expect(await counts()).toMatchObject({ postsCount: 1, repostsCount: 1 });
    await setType('boost');
    expect(await counts()).toMatchObject({ postsCount: 1, repostsCount: 1 });
    await setType('text');
    expect(await counts()).toMatchObject({ postsCount: 1, repostsCount: 0 });
  });

  it('declares both triggers over "is a repost", not over the raw value', async () => {
    const rows = await db.execute<{ def: string }>(sql`
      select pg_get_triggerdef(oid) as def from pg_trigger
      where tgrelid = 'posts'::regclass and tgname in ('posts_author_counts_update', 'posts_topic_affinity_update')
    `);
    expect([...rows]).toHaveLength(2);
    for (const row of rows) {
      expect(row.def).toContain("ARRAY['boost'::text, 'repost'::text]");
      expect(row.def).not.toContain('old.type IS DISTINCT FROM new.type');
    }
  });
});
