import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { reportNodeinfoAuthors } from '../../scripts/reportNodeinfoAuthors';

const ids: string[] = [];

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  if (ids.length) await getDb().delete(posts).where(inArray(posts.id, ids));
  await closePostgres();
});

describe('reportNodeinfoAuthors', () => {
  it('counts distinct public published local authors and ignores drafts and federated rows', async () => {
    // `posts` is shared with every suite on this database: assert on DELTAS.
    const before = await reportNodeinfoAuthors();
    const inserted = await getDb()
      .insert(posts)
      .values([
        { oxyUserId: 'rna-a' },
        { oxyUserId: 'rna-a' },
        { oxyUserId: 'rna-b' },
        { oxyUserId: 'rna-draft', status: 'draft' },
        { oxyUserId: 'rna-ext', federationActorUri: 'https://remote.example/users/rna' },
      ])
      .returning({ id: posts.id });
    ids.push(...inserted.map((row) => row.id));

    const after = await reportNodeinfoAuthors();

    expect(after.localAuthors - before.localAuthors).toBe(2);
    expect(after.localPosts - before.localPosts).toBe(3);
    expect(after.authorsWithOnePost - before.authorsWithOnePost).toBe(1);
  });
});
