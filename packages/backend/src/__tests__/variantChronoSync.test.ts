/**
 * `post_content_variants.post_created_at` — the copy of `posts.created_at` the
 * posts search bounds its text match with (#1158) — agrees with the post at
 * every path that writes a rendition. The backfill of rows written before the
 * column existed is `scripts/backfillVariantPostCreatedAtRows.test.ts`.
 *
 * Checked against `posts.created_at` in SQL rather than against a value the
 * test passed in, so a writer that stores a plausible-but-wrong timestamp fails.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { postContentVariants, posts } from '../db/schema';
import {
  insertPostRecord,
  replacePostContent,
  storeMachineVariant,
} from '../db/posts/postRepository';

const created: string[] = [];
const AUTHOR = 'variant-chronosync-author';

async function create(createdAt: Date): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'first body', tag: 'en' }] },
    createdAt,
  });
  created.push(record.id);
  return record.id;
}

/** This suite's renditions, with their copy and the post's own timestamp. */
async function renditions(): Promise<Array<{ copy: Date | null; source: Date }>> {
  if (created.length === 0) return [];
  const rows = await getDb()
    .select({ copy: postContentVariants.postCreatedAt, source: posts.createdAt })
    .from(postContentVariants)
    .innerJoin(posts, eq(posts.id, postContentVariants.postId))
    .where(inArray(postContentVariants.postId, [...created]));
  return rows;
}

async function disagreeing(): Promise<number> {
  const rows = await renditions();
  return rows.filter((row) => row.copy?.getTime() !== row.source.getTime()).length;
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

describe('post_content_variants.post_created_at', () => {
  it('is copied from the post when a post is created', async () => {
    await create(new Date('2026-03-04T05:06:07.000Z'));

    expect((await renditions()).length).toBe(1);
    expect(await disagreeing()).toBe(0);
  });

  it('is copied from the post when an edit replaces the renditions', async () => {
    const id = await create(new Date('2026-03-04T05:06:07.000Z'));

    await replacePostContent(id, { variants: [{ source: 'author', text: 'edited body', tag: 'en' }] }, []);

    expect((await renditions()).length).toBe(1);
    expect(await disagreeing()).toBe(0);
  });

  it('is copied from the post when a machine translation is stored', async () => {
    const id = await create(new Date('2026-03-04T05:06:07.000Z'));

    const outcome = await storeMachineVariant(
      id,
      { source: 'machine', text: 'primer cuerpo', tag: 'es' },
      { force: false, sourceMatches: () => true },
    );

    expect(outcome.kind).toBe('stored');
    expect((await renditions()).length).toBe(2);
    expect(await disagreeing()).toBe(0);
  });
});
