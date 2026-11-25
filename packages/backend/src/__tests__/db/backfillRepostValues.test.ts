import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { insertPostRecord } from '../../db/posts/postRepository';
import { posts } from '../../db/schema/posts';
import { backfillRepostValues } from '../../scripts/backfillRepostValues';

let db: Database;
const created: string[] = [];
const AUTHOR = `values-author-${process.pid}-${Date.now()}`;

async function newPost(storedType: 'boost' | 'repost' | 'text'): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'values fixture' }] },
  });
  created.push(record.id);
  if (storedType !== 'text')
    await db.execute(sql`update posts set type = ${storedType} where id = ${record.id}`);
  return record.id;
}

const typeOf = async (id: string) =>
  (await db.execute<{ type: string }>(sql`select type from posts where id = ${id}`))[0]?.type;

beforeAll(async () => {
  db = await connectPostgres();
});
afterEach(async () => {
  if (created.length > 0) {
    await db.delete(posts).where(inArray(posts.id, created));
    created.length = 0;
  }
});
afterAll(async () => {
  await closePostgres();
});

describe('backfillRepostValues', () => {
  it('rewrites only the old value, writes nothing on a dry run or a second run, and the shards partition the rows', async () => {
    const old = [await newPost('boost'), await newPost('boost'), await newPost('boost')];
    const fresh = await newPost('repost');
    const text = await newPost('text');
    const ids = [...old, fresh, text];

    expect(
      (await backfillRepostValues({ only: ['posts'], ids, dryRun: true, pauseMs: 0 })).posts,
    ).toBe(3);
    expect(await typeOf(old[0])).toBe('boost');

    let touched = 0;
    for (let index = 0; index < 2; index += 1) {
      touched += (
        await backfillRepostValues({
          only: ['posts'],
          ids,
          shard: { index, count: 2 },
          batchSize: 1,
          pauseMs: 0,
        })
      ).posts;
    }
    expect(touched).toBe(3);
    expect(await Promise.all(old.map(typeOf))).toEqual(['repost', 'repost', 'repost']);
    expect(await typeOf(fresh)).toBe('repost');
    expect(await typeOf(text)).toBe('text');
    expect((await backfillRepostValues({ only: ['posts'], ids, pauseMs: 0 })).posts).toBe(0);

    await expect(backfillRepostValues({ shard: { index: 2, count: 2 } })).rejects.toThrow(
      'Invalid shard',
    );
  });

  it('renames an import reason, and drops the old one when the post already has the new one', async () => {
    const both = await newPost('text');
    const onlyOld = await newPost('text');
    for (const id of [both, onlyOld]) {
      await db.execute(
        sql`insert into federation_post_imports (post_id, initial_reason) values (${id}, 'boost_dependency')`,
      );
    }
    await db.execute(
      sql`insert into federation_post_import_reasons (post_id, reason) values (${both}, 'boost_dependency'), (${both}, 'repost_dependency'), (${onlyOld}, 'boost_dependency')`,
    );

    await backfillRepostValues({
      only: ['federation_post_imports', 'federation_post_import_reasons'],
      ids: [both, onlyOld],
      pauseMs: 0,
    });

    const reasons = await db.execute<{ post_id: string; reason: string }>(
      sql`select post_id, reason from federation_post_import_reasons where post_id in (${both}, ${onlyOld}) order by post_id, reason`,
    );
    expect([...reasons].map((r) => r.reason).sort()).toEqual([
      'repost_dependency',
      'repost_dependency',
    ]);
    expect(new Set([...reasons].map((r) => r.post_id)).size).toBe(2);
    const initial = await db.execute<{ initial_reason: string }>(
      sql`select initial_reason from federation_post_imports where post_id in (${both}, ${onlyOld})`,
    );
    expect([...initial].every((r) => r.initial_reason === 'repost_dependency')).toBe(true);
  });
});
