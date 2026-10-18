/**
 * `purgeWrappedMachineTranslations` against real rows: it deletes only MACHINE
 * renditions that still carry the prompt wrapper, never an author one, and
 * leaves a post that is genuinely about the tag alone.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility, type PostContentVariant } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { postContentVariants } from '../../db/schema/postContent';
import { insertPostRecord } from '../../db/posts/postRepository';
import { purgeWrappedMachineTranslations } from '../../scripts/purgeWrappedMachineTranslations';

const OWNER = 'purge-wrapped-translation-owner';
const created: string[] = [];

async function seed(variants: PostContentVariant[]): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OWNER,
    authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants },
  });
  created.push(record.id);
  return record.id;
}

async function renditions(postId: string) {
  return getDb()
    .select({
      position: postContentVariants.position,
      tag: postContentVariants.tag,
      source: postContentVariants.source,
    })
    .from(postContentVariants)
    .where(eq(postContentVariants.postId, postId))
    .orderBy(asc(postContentVariants.position));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  if (created.length > 0) {
    await getDb()
      .delete(posts)
      .where(inArray(posts.id, [...created]));
    created.length = 0;
  }
});

describe('purgeWrappedMachineTranslations', () => {
  it('deletes wrapped machine variants only, and a dry run deletes nothing', async () => {
    const wrapped = await seed([
      { tag: 'en', source: 'author', text: 'hello' },
      { tag: 'ca-ES', source: 'machine', text: '<text>\nhola\n</text>' },
      { tag: 'es', source: 'machine', text: 'hola' },
    ]);
    const aboutTheTag = await seed([
      { tag: 'en', source: 'author', text: 'the <text> element' },
      { tag: 'es', source: 'machine', text: 'el elemento <text>' },
    ]);

    const dry = await purgeWrappedMachineTranslations({ dryRun: true });
    expect(dry).toMatchObject({ candidates: 1, deleted: 0 });

    const result = await purgeWrappedMachineTranslations({ dryRun: false });
    expect(result).toMatchObject({ candidates: 1, posts: 1, deleted: 1, noOpWrites: false });

    expect(await renditions(wrapped)).toEqual([
      { position: 0, tag: 'en', source: 'author' },
      { position: 1, tag: 'es', source: 'machine' },
    ]);
    expect(await renditions(aboutTheTag)).toHaveLength(2);
  });
});
