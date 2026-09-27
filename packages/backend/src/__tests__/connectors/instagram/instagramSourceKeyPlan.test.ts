import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { postMatchesFederatedObjectSql } from '../../../connectors/shared/instagramSourceKey';

/**
 * THE PLAN of "is this federated object already here?" for a bridged Instagram
 * Note — the predicate every inbox Create, Delete, Update, Like and Announce of a
 * kilogram Note runs, with the Graph connector on or OFF.
 *
 * A correlated `exists (… post_id = posts.id …)` inside the `or` cannot use an
 * index on `posts`, so it planned as a sequential scan of the whole table on
 * every bridged activity — and stayed one even with `enable_seqscan = off`,
 * which is exactly what this asserts against. Sequential scans are disabled
 * here so the answer does not depend on how small the test table is: if the
 * planner still picks one, no index can serve the predicate.
 */

const NOTE = 'https://kilogram.makeup/users/planprobe/statuses/DqPlanProbe01';

async function planOf(where: SQL): Promise<string> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain select ${posts.id} from ${posts} where ${where}`);
    return [...rows].map((row) => row['QUERY PLAN']).join('\n');
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('the source-key match is index-driven', () => {
  it('the dedupe / Delete / Update predicate never scans posts sequentially', async () => {
    const plan = await planOf(postMatchesFederatedObjectSql(NOTE));
    expect(plan).not.toMatch(/Seq Scan on posts/);
    expect(plan).toMatch(/post_source_keys_source_key_key/);
    expect(plan).toMatch(/posts_federation_activity_id_key/);
  });

  it('nor does the published-object resolution (Like / Announce / reply parent)', async () => {
    const plan = await planOf(and(
      postMatchesFederatedObjectSql(NOTE),
      eq(posts.status, 'published'),
      eq(posts.visibility, PostVisibility.PUBLIC),
    ) as SQL);
    expect(plan).not.toMatch(/Seq Scan on posts/);
  });
});

describe('the federated-media deletion reference check is index-driven', () => {
  async function planOfRaw(query: SQL): Promise<string> {
    return getDb().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const rows = await tx.execute<{ 'QUERY PLAN': string }>(sql`explain ${query}`);
      return [...rows].map((row) => row['QUERY PLAN']).join('\n');
    });
  }

  it('looks variant media up by id without scanning post_variant_media', async () => {
    const plan = await planOfRaw(sql`select media_id from post_variant_media where media_id in ('a', 'b')`);
    expect(plan).not.toMatch(/Seq Scan on post_variant_media/);
    expect(plan).toMatch(/post_variant_media_media_id_idx/);
  });

  it('looks banners up by file id without scanning user_settings', async () => {
    const plan = await planOfRaw(sql`select profile_header_image from user_settings where profile_header_image in ('a', 'b')`);
    expect(plan).not.toMatch(/Seq Scan on user_settings/);
    expect(plan).toMatch(/user_settings_profile_header_image_idx/);
  });
});
