import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The report also asks Oxy for the application's account total. Through the
// real runtime client that was a workload-token mint (a POST to Oxy's challenge)
// and then the read itself — two network round trips in a database test.
const { applicationAccountTotal } = vi.hoisted(() => ({
  applicationAccountTotal: vi.fn(async () => ({ total: 9, exact: true, stale: false })),
}));
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({ applicationAccountTotal }),
}));
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
    // This file runs on its own database (isolatedDatabaseFiles.ts), so the report is exact.
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

    const report = await reportNodeinfoAuthors();

    expect(report.localAuthors).toBe(2);
    expect(report.localPosts).toBe(3);
    expect(report.authorsWithOnePost).toBe(1);
    expect(report.oxyTotal).toEqual({ total: 9, exact: true, stale: false });
  });
});
