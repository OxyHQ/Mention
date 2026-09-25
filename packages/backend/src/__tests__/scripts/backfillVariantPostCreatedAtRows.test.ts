/**
 * `backfillVariantPostCreatedAt` copies `posts.created_at` onto every rendition
 * written before `post_content_variants.post_created_at` existed, and builds the
 * index the posts search's time windows use (#1158).
 *
 * It sweeps EVERY rendition in the table — a repair that only fixed the
 * caller's rows would repair nothing in production — so this file runs against
 * its own database (`isolatedDatabaseFiles.ts`), where its live pass cannot
 * rewrite another suite's rows or wait on another suite's transaction while it
 * builds the index concurrently.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { postContentVariants, posts } from '../../db/schema';
import { insertPostRecord } from '../../db/posts/postRepository';
import {
  VARIANT_POST_CREATED_AT_INDEX,
  backfillVariantPostCreatedAt,
} from '../../scripts/backfillVariantPostCreatedAt';

const created: string[] = [];
const AUTHOR = 'variant-backfill-author';

async function create(createdAt: Date): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'a body', tag: 'en' }] },
    createdAt,
  });
  created.push(record.id);
  return record.id;
}

/** Renditions whose copy disagrees with their post, compared in SQL. */
async function disagreeing(): Promise<number> {
  const rows = await getDb()
    .select({ id: postContentVariants.id })
    .from(postContentVariants)
    .innerJoin(posts, eq(posts.id, postContentVariants.postId))
    .where(sql`${postContentVariants.postCreatedAt} is distinct from ${posts.createdAt}`);
  return rows.length;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  if (created.length > 0) {
    await getDb().delete(posts).where(inArray(posts.id, created.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('backfillVariantPostCreatedAt', () => {
  it('reports without writing on a dry run', async () => {
    const id = await create(new Date('2026-01-02T03:04:05.000Z'));
    await getDb().execute(sql`update post_content_variants set post_created_at = null where post_id = ${id}`);

    const result = await backfillVariantPostCreatedAt({ dryRun: true });

    expect(result.candidates).toBe(1);
    expect(result.written).toBe(0);
    expect(await disagreeing()).toBe(1);
  });

  it('repairs NULL and wrong copies across batches, and builds a valid index', async () => {
    const ids = await Promise.all([
      create(new Date('2026-01-02T03:04:05.000Z')),
      create(new Date('2026-02-03T04:05:06.000Z')),
      create(new Date('2026-03-04T05:06:07.000Z')),
    ]);
    // The state every pre-migration row is in, and one that disagrees outright.
    await getDb().execute(sql`update post_content_variants set post_created_at = null where post_id in (${ids[0]}, ${ids[1]})`);
    await getDb().execute(sql`update post_content_variants set post_created_at = now() where post_id = ${ids[2]}`);
    expect(await disagreeing()).toBe(3);

    // A batch of one forces the keyset walk across several pages.
    const result = await backfillVariantPostCreatedAt({ dryRun: false, batchSize: 1, pauseMs: 0 });

    expect(result.candidates).toBe(3);
    expect(result.written).toBe(3);
    expect(result.indexValid).toBe(true);
    expect(await disagreeing()).toBe(0);
    const [index] = await getDb().execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes where indexname = ${VARIANT_POST_CREATED_AT_INDEX}
    `);
    expect(index?.indexdef).toContain('USING btree (post_created_at)');
  }, 60_000);

  it('is idempotent: a second run writes nothing', async () => {
    const id = await create(new Date('2026-01-02T03:04:05.000Z'));
    await getDb().execute(sql`update post_content_variants set post_created_at = null where post_id = ${id}`);
    await backfillVariantPostCreatedAt({ dryRun: false, pauseMs: 0 });

    const second = await backfillVariantPostCreatedAt({ dryRun: false, pauseMs: 0 });

    expect(second.candidates).toBe(0);
    expect(second.written).toBe(0);
    expect(second.indexValid).toBe(true);
  }, 60_000);
});
