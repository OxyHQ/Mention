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
    // `posts` is shared with concurrent suites: scope the report to this file's authors.
    const scope = { authorPrefix: 'rna-' };
    const inserted = await getDb()
      .insert(posts)
      .values([
        { oxyUserId: 'rna-a' },
        { oxyUserId: 'rna-a' },
        { oxyUserId: 'rna-b' },
        { oxyUserId: 'rna-draft', status: 'draft' },
        { oxyUserId: 'rna-ext', federationActorUri: 'https://remote.example/users/rna' },
        { oxyUserId: 'rna-legacy', federationActivityId: 'https://remote.example/rna/1' },
      ])
      .returning({ id: posts.id });
    ids.push(...inserted.map((row) => row.id));

    const report = await reportNodeinfoAuthors(scope);

    expect(report.localAuthors).toBe(2);
    expect(report.localPosts).toBe(3);
    expect(report.authorsWithOnePost).toBe(1);
  });
});
