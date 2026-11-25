/**
 * The boost -> repost rename is in its EXPAND phase: `posts` carries both names of
 * four columns, and `posts_sync_repost_columns` (0126) keeps each pair equal
 * whichever name a writer used. That is what lets a pod on the old code and a pod
 * on the new one run side by side, so every direction a writer can take is held
 * here against the real trigger.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { insertPostRecord } from '../../db/posts/postRepository';
import { posts } from '../../db/schema/posts';

let db: Database;
const created: string[] = [];
const AUTHOR = `sync-author-${process.pid}-${Date.now()}`;

async function newPost(): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'sync fixture' }] },
  });
  created.push(record.id);
  return record.id;
}

async function read(id: string) {
  const [row] = await db
    .select({
      boostOf: posts.repostOf,
      repostOf: posts.repostOf,
      boosts: posts.statsRepostsCount,
      reposts: posts.statsRepostsCount,
      federatedBoosts: posts.statsFederatedRepostsCount,
      federatedReposts: posts.statsFederatedRepostsCount,
      isBoosted: posts.metadataIsReposted,
      isReposted: posts.metadataIsReposted,
      likes: posts.statsLikesCount,
    })
    .from(posts)
    .where(eq(posts.id, id));
  return row;
}

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

describe('posts_sync_repost_columns', () => {
  it('copies a row written through the OLD names to the new ones, and the reverse, on insert', async () => {
    const original = await newPost();
    const viaOld = await newPost();
    await db
      .update(posts)
      .set({
        boostOf: original,
        statsBoostsCount: 4,
        statsFederatedBoostsCount: 1,
        metadataIsBoosted: true,
      })
      .where(eq(posts.id, viaOld));
    expect(await read(viaOld)).toMatchObject({
      repostOf: original,
      reposts: 4,
      federatedReposts: 1,
      isReposted: true,
    });

    const inserted = await db
      .insert(posts)
      .values({
        oxyUserId: AUTHOR,
        type: 'text',
        visibility: 'public',
        status: 'published',
        repostOf: original,
        statsRepostsCount: 7,
        statsFederatedRepostsCount: 2,
        metadataIsReposted: true,
      })
      .returning({ id: posts.id });
    created.push(inserted[0].id);
    expect(await read(inserted[0].id)).toMatchObject({
      boostOf: original,
      boosts: 7,
      federatedBoosts: 2,
      isBoosted: true,
    });
  });

  it('follows a pointer written under either name, including clearing it', async () => {
    const original = await newPost();
    const post = await newPost();

    await db.execute(sql`update posts set repost_of = ${original} where id = ${post}`);
    expect(await read(post)).toMatchObject({ boostOf: original, repostOf: original });

    await db.execute(sql`update posts set boost_of = null where id = ${post}`);
    expect(await read(post)).toMatchObject({ boostOf: null, repostOf: null });

    await db.execute(sql`update posts set boost_of = ${original} where id = ${post}`);
    expect(await read(post)).toMatchObject({ boostOf: original, repostOf: original });
  });

  it('keeps the counters equal when a writer increments only one of the two names', async () => {
    const post = await newPost();

    await db.execute(
      sql`update posts set stats_boosts_count = stats_boosts_count + 1 where id = ${post}`,
    );
    await db.execute(
      sql`update posts set stats_reposts_count = stats_reposts_count + 1 where id = ${post}`,
    );
    await db.execute(
      sql`update posts set stats_federated_boosts_count = stats_federated_boosts_count + 3 where id = ${post}`,
    );
    await db.execute(
      sql`update posts set stats_federated_reposts_count = stats_federated_reposts_count - 1 where id = ${post}`,
    );

    expect(await read(post)).toMatchObject({
      boosts: 2,
      reposts: 2,
      federatedBoosts: 2,
      federatedReposts: 2,
    });
  });

  it('follows the viewer flag under either name, and ignores an update that touches none of them', async () => {
    const post = await newPost();

    await db.execute(sql`update posts set metadata_is_boosted = true where id = ${post}`);
    expect(await read(post)).toMatchObject({ isBoosted: true, isReposted: true });
    await db.execute(sql`update posts set metadata_is_reposted = false where id = ${post}`);
    expect(await read(post)).toMatchObject({ isBoosted: false, isReposted: false });

    await db.execute(sql`update posts set stats_likes_count = 9 where id = ${post}`);
    expect(await read(post)).toMatchObject({ likes: 9, boosts: 0, reposts: 0, isBoosted: false });
  });
});
