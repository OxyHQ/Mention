/**
 * The federated-boost-count backfill, against REAL ROWS.
 *
 * The previous version of this file mocked `Post.find` / `Post.countDocuments` /
 * `Post.bulkWrite` over an in-memory array. Two of its four cases could not fail
 * for the right reason: the count case asserted the MOCK's filter predicate
 * rather than the script's query, and the "reports count failures" case staged
 * the failure with `mockRejectedValueOnce` — a rejection nothing in the script
 * could have caused, so it proved only that a `try` exists.
 *
 * What a real database is needed for here is one thing above all: the script
 * distinguishes a FEDERATED Announce from a native repost by the presence of
 * `federation_activity_id` on the boost row. Against a mock that predicate is
 * whatever the mock says it is. Against real rows it is the query.
 *
 * On the failure case, deliberately NOT reinstated: the per-post `try` now wraps
 * a single-row UPDATE by primary key with a computed non-negative integer, so
 * against a real database there is no honest way to make exactly one of them
 * fail — every mechanism (a temporary trigger, a lock timeout) is a fiction
 * bolted onto a shared table, and would assert the fiction rather than the
 * guarantee. The half of that guarantee that IS real and reachable — a run that
 * ends with `failed > 0` must exit non-zero rather than report success — belongs
 * to `assertAdminRunComplete` and is covered in `adminDeletionPreflight.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { deletePostRecord, insertPostRecord } from '../db/posts/postRepository';
import type { PostRecordInput } from '../db/posts/postRecord';
import { backfillFederatedBoostCounts } from '../scripts/backfillFederatedBoostCounts';

const OWNER = 'oxy-boost-backfill-owner';
const BOOSTER = 'oxy-boost-backfill-booster';

describe('backfillFederatedBoostCounts', () => {
  const created: string[] = [];

  async function seed(overrides: Partial<PostRecordInput> = {}): Promise<string> {
    const owner = (overrides.oxyUserId ?? OWNER) as string;
    const record = await insertPostRecord({
      oxyUserId: owner,
      authorship: [{ oxyUserId: owner, role: 'owner', status: 'accepted' }],
      type: PostType.TEXT,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      content: { variants: [{ source: 'author', text: 'original', tag: 'en' }] },
      ...overrides,
    });
    created.push(record.id);
    return record.id;
  }

  /** A boost row. Federated when `activityId` is supplied, native otherwise. */
  async function seedBoost(boostOf: string, activityId?: string): Promise<string> {
    return seed({
      oxyUserId: BOOSTER,
      type: PostType.BOOST,
      content: {},
      boostOf,
      ...(activityId
        ? { federation: { activityId, actorUri: 'https://remote.example/users/booster' } }
        : {}),
    });
  }

  async function readRow(id: string): Promise<{ count: number; updatedAt: Date }> {
    const [row] = await getDb()
      .select({ count: posts.statsFederatedBoostsCount, updatedAt: posts.updatedAt })
      .from(posts)
      .where(eq(posts.id, id));
    return row;
  }

  beforeAll(async () => {
    await connectPostgres();
  });

  afterEach(async () => {
    // Newest first: a boost references the original it must be deleted before.
    for (const id of created.splice(0).reverse()) {
      await deletePostRecord(id, undefined);
    }
  });

  afterAll(async () => {
    await closePostgres();
  });

  it('counts federated Announces only, never native reposts, and is idempotent', async () => {
    const original = await seed();
    await seedBoost(original, `https://remote.example/a/${randomUUID()}`);
    await seedBoost(original, `https://remote.example/a/${randomUUID()}`);
    // A native repost: `boost_of` + `type = 'boost'` but no federation activity
    // id. It must NOT be counted — that distinction is the whole script.
    await seedBoost(original);

    const first = await backfillFederatedBoostCounts({ postIds: [original] });
    expect(first).toEqual({ scanned: 1, updated: 1, failed: 0 });
    expect((await readRow(original)).count).toBe(2);

    // Idempotency asserted on the ROW, not on a call count: a second run that
    // wrote would move `updated_at`, since the column carries `$onUpdate`.
    const before = await readRow(original);
    const second = await backfillFederatedBoostCounts({ postIds: [original] });
    expect(second).toEqual({ scanned: 1, updated: 0, failed: 0 });
    expect(await readRow(original)).toEqual(before);
  });

  it('corrects a stored count DOWNWARD when federated boosts were undone', async () => {
    // The direction that matters operationally: an Undo(Announce) deletes the
    // boost row, so a stale stored count is too HIGH. A backfill that only ever
    // raised the number would leave it wrong and report success.
    const original = await seed();
    const boost = await seedBoost(original, `https://remote.example/a/${randomUUID()}`);
    await backfillFederatedBoostCounts({ postIds: [original] });
    expect((await readRow(original)).count).toBe(1);

    await deletePostRecord(boost, undefined);
    created.splice(created.indexOf(boost), 1);

    const result = await backfillFederatedBoostCounts({ postIds: [original] });
    expect(result).toEqual({ scanned: 1, updated: 1, failed: 0 });
    expect((await readRow(original)).count).toBe(0);
  });

  it('leaves an already-correct post untouched — no write at all', async () => {
    const original = await seed();
    await seedBoost(original); // native only, so the correct count is the stored 0

    const before = await readRow(original);
    const result = await backfillFederatedBoostCounts({ postIds: [original] });

    expect(result).toEqual({ scanned: 1, updated: 0, failed: 0 });
    expect(await readRow(original)).toEqual(before);
  });

  it('reports what it would update under dryRun, and writes nothing', async () => {
    const original = await seed();
    await seedBoost(original, `https://remote.example/a/${randomUUID()}`);

    const before = await readRow(original);
    const result = await backfillFederatedBoostCounts({ postIds: [original], dryRun: true });

    expect(result).toEqual({ scanned: 1, updated: 1, failed: 0 });
    // Both halves are load-bearing: the count is still 0 AND the row was never
    // rewritten with the same value, which `updated_at` is what proves.
    expect(await readRow(original)).toEqual(before);
    expect(before.count).toBe(0);
  });

  it('pages with a stable ascending cursor rather than revisiting or skipping', async () => {
    // Three originals with distinct true counts, swept at a page size of TWO —
    // deliberately not one. With a page of one, `page[0]` and
    // `page[page.length - 1]` are the same row, so a cursor taking the FIRST id
    // of the page instead of the last is indistinguishable from a correct one;
    // mutating the script that way passed this test until the page size grew.
    // At two, a first-id cursor re-reads the overlap and `scanned` climbs.
    const originals = [await seed(), await seed(), await seed()];
    await seedBoost(originals[0], `https://remote.example/a/${randomUUID()}`);
    await seedBoost(originals[2], `https://remote.example/a/${randomUUID()}`);
    await seedBoost(originals[2], `https://remote.example/a/${randomUUID()}`);

    const result = await backfillFederatedBoostCounts({ postIds: originals, batchSize: 2 });

    expect(result).toEqual({ scanned: 3, updated: 2, failed: 0 });
    expect(
      await Promise.all(originals.map(async (id) => (await readRow(id)).count)),
    ).toEqual([1, 0, 2]);
  });
});
