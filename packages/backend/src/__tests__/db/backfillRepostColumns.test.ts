import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { insertPostRecord } from '../../db/posts/postRepository';
import { posts } from '../../db/schema/posts';
import { backfillRepostColumns } from '../../scripts/backfillRepostColumns';

let db: Database;
const created: string[] = [];
const AUTHOR = `backfill-author-${process.pid}-${Date.now()}`;

async function newPost(): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'backfill fixture' }] },
  });
  created.push(record.id);
  return record.id;
}

/** A row as it was written BEFORE the sync trigger existed: old columns only. */
async function writeOldColumnsOnly(id: string, original: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx
      .update(posts)
      .set({
        boostOf: original,
        statsBoostsCount: 3,
        statsFederatedBoostsCount: 1,
        metadataIsBoosted: true,
      })
      .where(eq(posts.id, id));
  });
}

const read = async (id: string) =>
  (
    await db
      .select({
        repostOf: posts.repostOf,
        reposts: posts.statsRepostsCount,
        federatedReposts: posts.statsFederatedRepostsCount,
        isReposted: posts.metadataIsReposted,
      })
      .from(posts)
      .where(eq(posts.id, id))
  )[0];

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

describe('backfillRepostColumns', () => {
  it('copies the old columns of a row the trigger never saw, leaves a level row alone, and is idempotent', async () => {
    const original = await newPost();
    const old = await newPost();
    const level = await newPost();
    await writeOldColumnsOnly(old, original);
    expect(await read(old)).toMatchObject({ repostOf: null, reposts: 0, isReposted: false });

    const dry = await backfillRepostColumns({ dryRun: true, postIds: [old, level] });
    expect(dry.updated).toBe(1);
    expect(await read(old)).toMatchObject({ repostOf: null }); // dry run wrote nothing

    const first = await backfillRepostColumns({ postIds: [old, level], batchSize: 1, pauseMs: 0 });
    expect(first.updated).toBe(1);
    expect(await read(old)).toEqual({
      repostOf: original,
      reposts: 3,
      federatedReposts: 1,
      isReposted: true,
    });
    expect(await read(level)).toEqual({
      repostOf: null,
      reposts: 0,
      federatedReposts: 0,
      isReposted: false,
    });

    expect((await backfillRepostColumns({ postIds: [old, level] })).updated).toBe(0);
  });
});
