/**
 * One boost per account per post, enforced where it can actually be enforced.
 *
 * `createBoost` reads for an existing boost and then inserts, with nothing
 * between the two. That read cannot be made authoritative — there is no row to
 * lock and no ordering that closes the window — so two concurrent boosts both
 * see "no" and both insert. Nothing downstream copes with the second row:
 * unboost and the federated `Undo(Announce)` each delete ONE and leave the
 * other, so the user unboosts and the boost is still there, and
 * `stats.boosts_count` drifts by however many duplicates were made.
 *
 * `posts_one_boost_per_account_key` is the authority; the read is an
 * optimisation. So the tests below fire the requests CONCURRENTLY rather than in
 * sequence: a sequential pair is answered by the read and proves nothing about
 * the constraint, which is exactly how this survived being "checked" for as long
 * as it did.
 *
 * The constraint covers NATIVE boosts only. A federated boost mirrors a remote
 * actor's Announce and is deduped by the Announce id, so a re-Announce after a
 * lost `Undo` legitimately produces a second row — see the index's own docblock,
 * and `backfillFederatedBoostCounts.test.ts`, which is the test that refused the
 * wider version of this rule.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn(async () => undefined),
  emitRepostCreated: vi.fn(async () => undefined),
  emitTombstone: vi.fn(async () => undefined),
  repostRecordUri: vi.fn(() => undefined),
}));
vi.mock('../../connectors/outboundFederation', () => ({
  federateAsResolvedActor: vi.fn(async () => undefined),
}));
vi.mock('../../services/AffinityEventService', () => ({
  affinityEventService: { record: vi.fn(async () => undefined) },
}));
vi.mock('../../services/UserPreferenceService', () => ({
  userPreferenceService: { recordInteraction: vi.fn(async () => undefined) },
  readInteractionSurface: vi.fn(() => undefined),
}));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (rows: { id: string }[]) => rows) },
}));
vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  getServiceOxyClient: vi.fn(() => ({})),
}));
vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { postAuthorships } from '../../db/schema/postContent';
import { uuidv7 } from '../../db/schema/columns';
import { insertPostRecord } from '../../db/posts/postRepository';
import { buildAuthorship } from '../../utils/postAuthorship';
import { feedController } from '../../controllers/feed.controller';

let db: Database;

/**
 * Vitest runs test FILES in parallel against ONE database, so this file owns its
 * ids — `src/__tests__/fixtureIdOwnership.test.ts` gates the rule.
 */
const NAMESPACE = `boost-unique-${randomUUID().slice(0, 8)}`;
const createdPostIds: string[] = [];

function booster(): string {
  return `oxy-${NAMESPACE}-booster-${randomUUID().slice(0, 8)}`;
}

/** A published public post for someone to boost. */
async function seedOriginal(): Promise<string> {
  const record = await insertPostRecord({
    id: uuidv7(),
    oxyUserId: `oxy-${NAMESPACE}-author`,
    authorship: buildAuthorship(`oxy-${NAMESPACE}-author`, []),
    content: { variants: [{ source: 'author', text: 'boost me', tag: 'en' }] },
    status: 'published',
    visibility: 'public',
  });
  createdPostIds.push(record.id);
  return record.id;
}

interface CapturedResponse {
  statusCode: number;
  body: unknown;
}

function makeRes(): Response & CapturedResponse {
  const res = {
    // Express's own default: a handler that calls `json()` without `status()`
    // answers 200, which is exactly what the unboost success path does.
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & CapturedResponse;
}

function makeReq(viewer: string, originalPostId: string): AuthRequest {
  return {
    user: { id: viewer },
    body: { originalPostId },
    params: {},
    query: {},
    headers: {},
  } as unknown as AuthRequest;
}

/** Every boost row of `original`, whoever made it. */
async function boostRows(original: string) {
  return db
    .select({ id: posts.id, oxyUserId: posts.oxyUserId })
    .from(posts)
    .where(and(eq(posts.boostOf, original), eq(posts.type, 'boost')));
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  // Boosts reference their original, so they go first.
  const originals = [...createdPostIds];
  createdPostIds.length = 0;
  if (originals.length === 0) return;
  const boosts = await db
    .select({ id: posts.id })
    .from(posts)
    .where(inArray(posts.boostOf, originals));
  const ids = [...boosts.map((row) => row.id), ...originals];
  await db.delete(postAuthorships).where(inArray(postAuthorships.postId, ids));
  await db.delete(posts).where(inArray(posts.id, ids));
});

afterAll(async () => {
  await closePostgres();
});

describe('boosting the same post twice at once', () => {
  it('leaves exactly one boost row, and tells the loser it already exists', async () => {
    const original = await seedOriginal();
    const viewer = booster();

    /**
     * CONCURRENT, not sequential. Issued together, both requests run their
     * "already boosted?" read before either insert commits, so both are cleared
     * to insert — the exact interleaving the read cannot prevent. Sequentially
     * the read answers the second one and the constraint is never exercised.
     */
    const [first, second] = await Promise.all([
      (async () => {
        const res = makeRes();
        await feedController.createBoost(makeReq(viewer, original), res);
        return res;
      })(),
      (async () => {
        const res = makeRes();
        await feedController.createBoost(makeReq(viewer, original), res);
        return res;
      })(),
    ]);

    const rows = await boostRows(original);
    expect(rows).toHaveLength(1);

    // One winner, one refusal — and the refusal is the ordinary 400, not a 500.
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 400]);
    const loser = [first, second].find((res) => res.statusCode === 400);
    expect(loser?.body).toEqual({ error: 'You have already boosted this content' });
  });

  it('lets two DIFFERENT accounts boost the same post concurrently', async () => {
    /**
     * The vacuity counterpart. A constraint scoped one column too wide would
     * satisfy the case above by refusing everything, and this is what notices:
     * the rule is one boost per ACCOUNT per post, not one boost per post.
     */
    const original = await seedOriginal();
    const [a, b] = [booster(), booster()];

    const responses = await Promise.all([a, b].map(async (viewer) => {
      const res = makeRes();
      await feedController.createBoost(makeReq(viewer, original), res);
      return res;
    }));

    expect(responses.map((res) => res.statusCode)).toEqual([201, 201]);
    const rows = await boostRows(original);
    expect(rows.map((row) => row.oxyUserId).sort()).toEqual([a, b].sort());
  });

  it('unboosting removes the boost, leaving none behind', async () => {
    /**
     * The half the duplicate broke. `unboostItem` deletes ONE row, so with a
     * duplicate present the user unboosted and the boost was still there. With
     * the constraint there is only ever one to delete, and this asserts the row
     * is gone rather than that the endpoint answered 200.
     */
    const original = await seedOriginal();
    const viewer = booster();

    const created = makeRes();
    await feedController.createBoost(makeReq(viewer, original), created);
    expect(created.statusCode).toBe(201);
    expect(await boostRows(original)).toHaveLength(1);

    const removed = makeRes();
    await feedController.unboostItem(
      { user: { id: viewer }, params: { postId: original }, body: {}, query: {}, headers: {} } as unknown as AuthRequest,
      removed,
    );

    expect(removed.statusCode).toBe(200);
    expect(await boostRows(original)).toHaveLength(0);
  });
});

describe('the constraint itself', () => {
  it('is declared in the live database as a PARTIAL unique index', async () => {
    /**
     * Read from `pg_indexes` rather than from the drizzle table object: the
     * mechanism under test is what the DATABASE enforces, and a schema file
     * declaring an index the migration never created would pass an assertion
     * made against the schema object while production kept making duplicates.
     *
     * The predicate is asserted too. Without it the index would still work — by
     * accident, because `boost_of` is NULL on every non-boost and Postgres
     * treats NULLs as distinct — and a later reader could not tell the rule from
     * the coincidence.
     */
    const rows = await db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
      where indexname = 'posts_one_boost_per_account_key'
    `);
    const [row] = [...rows];

    expect(row?.indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(row?.indexdef).toMatch(/\(oxy_user_id, boost_of\)/);
    expect(row?.indexdef).toMatch(/WHERE .*type = 'boost'/);
    // The half that keeps federation working: a remote re-Announce carries a new
    // activity id and MUST be allowed a second row. Without this clause the
    // inbox worker 23505s on it and retries forever.
    expect(row?.indexdef).toMatch(/federation_activity_id IS NULL/);
  });
});
