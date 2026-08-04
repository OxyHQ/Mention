/**
 * A starter pack must never store the same account twice.
 *
 * This shipped: pack `6a35840f2160a431714b96d5` held SEVEN entries for FIVE
 * accounts — `69bf1395db3d3cba5d28bc25` twice and `019fc915-…-f5828565e53c`
 * twice — and rendered every duplicate as its own row, with a "7 accounts"
 * count to match. The cause was not one buggy endpoint but a DISAGREEMENT
 * between three: `POST /:id/members` unioned into a `Set`, while `POST /` and
 * `PUT /:id` stored whatever array arrived. Which behaviour a pack got depended
 * on which endpoint its client used.
 *
 * ## Why this suite was rewritten
 *
 * It used to import `dedupeMemberIds` from `models/StarterPack` and assert
 * against that function alone. That model is the Mongo store, which no request
 * reaches any more — so the suite was five green assertions about unreachable
 * code, and it would have stayed green through any regression in the shipped
 * path. The guard moved with the store; the check has to move with it.
 *
 * ## Where the guarantee lives NOW, and why the tests are shaped this way
 *
 * The original argument for testing below the routes was that a FOURTH write
 * path added later should inherit the property without knowing it exists. That
 * argument is stronger under Postgres, not weaker — it is now discharged by the
 * schema itself: `starter_pack_members` carries
 * `unique('starter_pack_members_pack_id_oxy_user_id_key').on(packId, oxyUserId)`,
 * so a duplicate is a REFUSED WRITE rather than a value some helper happened to
 * clean up. The last test here watches that refusal, because a constraint nobody
 * has ever seen fire is indistinguishable from one that was never created.
 *
 * Every other test drives a REAL ROUTE against REAL ROWS, because that is the
 * only thing that can tell the three endpoints apart — and their disagreement,
 * not any single helper, is what produced the incident above.
 *
 * ## The ordering test is the one that is easy to lose
 *
 * `normalizeMemberIds` runs BEFORE the `STARTER_PACK_MAX_MEMBERS` check, so a
 * client that sent one id twice has not curated two accounts and must not be
 * charged for two. Swapping those two lines is invisible to every other
 * assertion in this file: 150 distinct ids still succeed and 151 distinct ids
 * still fail. Only the pair below — 151 entries collapsing to 150 distinct —
 * tells the two orderings apart, which is exactly the input shape that makes
 * the strict and loose readings disagree.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

// The collaborators the router imports for identity resolution, cache eviction
// and endorsement sync. All three reach outside this batch (Oxy over HTTP,
// Redis, the endorsement outbox), and none of them is the code under test.
vi.mock('../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn().mockResolvedValue(new Map()),
  isFallbackUserSummary: vi.fn().mockReturnValue(false),
}));
vi.mock('../services/userSummaryCache', () => ({ invalidate: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/EndorsementSignalService', () => ({
  endorsementSignalService: {
    syncScope: vi.fn().mockResolvedValue(undefined),
    syncScopeMembershipChange: vi.fn().mockResolvedValue(undefined),
    syncScopeRemoval: vi.fn().mockResolvedValue(undefined),
  },
}));

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { STARTER_PACK_MAX_MEMBERS, starterPackMembers, starterPacks } from '../db/schema/lists';
import starterPackRoutes from '../routes/starterPacks';

let db: Database;

const run = randomUUID();
const OWNER_ID = `owner-${run}`;
const createdPackIds: string[] = [];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string } }).user = { id: OWNER_ID };
  next();
});
app.use('/starter-packs', starterPackRoutes);

/** Distinct member ids, unique to this run so parallel files cannot collide. */
function memberIds(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `member-${run}-${index}`);
}

/** The member ids stored for a pack, in stored position order. */
async function storedMembers(packId: string): Promise<string[]> {
  const rows = await db
    .select({ oxyUserId: starterPackMembers.oxyUserId, position: starterPackMembers.position })
    .from(starterPackMembers)
    .where(eq(starterPackMembers.packId, packId));
  return rows.sort((a, b) => a.position - b.position).map((row) => row.oxyUserId);
}

async function createPack(memberOxyUserIds: unknown[]): Promise<request.Response> {
  const response = await request(app)
    .post('/starter-packs')
    .send({ name: `Pack ${randomUUID()}`, memberOxyUserIds });
  const id: unknown = response.body?.id;
  if (typeof id === 'string') createdPackIds.push(id);
  return response;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdPackIds.length > 0) {
    await db.delete(starterPacks).where(inArray(starterPacks.id, createdPackIds));
    createdPackIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('starter pack membership is a set, on every write path', () => {
  it('collapses a repeat on create, keeping the first occurrence in place', async () => {
    // Order is load-bearing: the list renders in stored order and the owner
    // chose it, so deduping must not double as a sort. `b` staying between `a`
    // and `c` is the assertion — a Set built from a sorted copy would pass a
    // length check and fail this.
    const [a, b, c] = memberIds(3);

    const response = await createPack([a, b, a, c, b]);

    expect(response.status).toBe(201);
    expect(await storedMembers(String(response.body.id))).toEqual([a, b, c]);
  });

  it('collapses a repeat on update — one of the two endpoints that stored the raw array', async () => {
    const [a, b, c] = memberIds(3);
    const created = await createPack([a]);
    expect(created.status).toBe(201);
    const packId = String(created.body.id);

    const response = await request(app)
      .put(`/starter-packs/${packId}`)
      .send({ memberOxyUserIds: [c, b, c, a, b] });

    expect(response.status).toBe(200);
    expect(await storedMembers(packId)).toEqual([c, b, a]);
  });

  it('collapses a repeat against the members already stored, on add', async () => {
    const [a, b, c] = memberIds(3);
    const created = await createPack([a, b]);
    expect(created.status).toBe(201);
    const packId = String(created.body.id);

    const response = await request(app)
      .post(`/starter-packs/${packId}/members`)
      .send({ userIds: [b, c, c, a] });

    expect(response.status).toBe(200);
    // Existing members keep their positions; only the genuinely new one appends.
    expect(await storedMembers(packId)).toEqual([a, b, c]);
  });

  it('collapses the exact production pack to its five real accounts', async () => {
    // The seven entries the incident pack actually held, in the order it held
    // them. Kept as a fixture because a regression reproduces THIS, and a
    // synthetic case would not name it.
    const objectId = '69bf1395db3d3cba5d28bc25';
    const uuid = '019fc915-3e50-7216-be11-f5828565e53c';

    const response = await createPack([
      objectId,
      objectId,
      uuid,
      uuid,
      '6a3583d5f24acd91fb2643b1',
      '6a3583e6f24acd91fb2643b5',
      '6a3583f0f24acd91fb2643b6',
    ]);

    expect(response.status).toBe(201);
    expect(await storedMembers(String(response.body.id))).toEqual([
      objectId,
      uuid,
      '6a3583d5f24acd91fb2643b1',
      '6a3583e6f24acd91fb2643b5',
      '6a3583f0f24acd91fb2643b6',
    ]);
  });

  it('treats ids as opaque, never normalising two distinct ones together', async () => {
    // The two id shapes in that pack are NOT interchangeable strings to a
    // reader: one is a 24-char Mongo ObjectId hex, the other a UUIDv7. They are
    // compared as opaque strings on purpose — normalising case or format would
    // risk merging two genuinely different accounts, far worse than a repeat.
    const response = await createPack(['69BF1395DB3D3CBA5D28BC25', '69bf1395db3d3cba5d28bc25']);

    expect(response.status).toBe(201);
    expect(await storedMembers(String(response.body.id))).toHaveLength(2);
  });

  it('drops the shapes a client can actually send instead of an id', async () => {
    // Not tidy inputs: a real body can carry a null from a failed lookup, a
    // number, or an empty string from a cleared field. Each would otherwise
    // become a member row pointing at nobody.
    const [a] = memberIds(1);

    const response = await createPack([a, '', null, 42, {}, a]);

    expect(response.status).toBe(201);
    expect(await storedMembers(String(response.body.id))).toEqual([a]);
  });

  it('stores no members for a non-array, rather than failing the request', async () => {
    // `memberOxyUserIds` arrives from `req.body`, so it can be anything at all.
    // A normaliser that threw would surface as a 500 on an ordinary bad request.
    const response = await createPack(['x'] as unknown[]);
    expect(response.status).toBe(201);

    const scalar = await request(app)
      .post('/starter-packs')
      .send({ name: `Pack ${randomUUID()}`, memberOxyUserIds: '69bf1395db3d3cba5d28bc25' });
    const scalarId: unknown = scalar.body?.id;
    if (typeof scalarId === 'string') createdPackIds.push(scalarId);

    expect(scalar.status).toBe(201);
    expect(await storedMembers(String(scalarId))).toEqual([]);
  });
});

describe('the member cap counts accounts, not entries', () => {
  it('accepts an over-cap request whose repeats collapse to exactly the cap', async () => {
    // The discriminating fixture. A cap checked BEFORE the dedupe refuses this
    // with a 400 while every other test in this file stays green.
    const distinct = memberIds(STARTER_PACK_MAX_MEMBERS);

    const response = await createPack([...distinct, distinct[0]]);

    expect(
      response.status,
      'A client that sent one id twice has not curated two accounts, so the cap must be applied ' +
        'to the deduplicated set — otherwise the 400 counts entries nobody will ever see.',
    ).toBe(201);
    expect(await storedMembers(String(response.body.id))).toHaveLength(STARTER_PACK_MAX_MEMBERS);
  });

  it('still refuses one account past the cap', async () => {
    // The control for the test above: without it, "dedupe first" could be
    // satisfied by never enforcing the cap at all.
    const response = await createPack(memberIds(STARTER_PACK_MAX_MEMBERS + 1));

    expect(response.status).toBe(400);
    expect(String(response.body.error)).toContain(String(STARTER_PACK_MAX_MEMBERS));
  });

  it('applies the same order on update, not only on create', async () => {
    const created = await createPack([]);
    expect(created.status).toBe(201);
    const packId = String(created.body.id);
    const distinct = memberIds(STARTER_PACK_MAX_MEMBERS);

    const accepted = await request(app)
      .put(`/starter-packs/${packId}`)
      .send({ memberOxyUserIds: [...distinct, distinct[0]] });
    expect(accepted.status).toBe(200);
    expect(await storedMembers(packId)).toHaveLength(STARTER_PACK_MAX_MEMBERS);

    const refused = await request(app)
      .put(`/starter-packs/${packId}`)
      .send({ memberOxyUserIds: memberIds(STARTER_PACK_MAX_MEMBERS + 1) });
    expect(refused.status).toBe(400);
  });
});

describe('the schema refuses a duplicate, so a future write path inherits the rule', () => {
  it('rejects a second row for the same account in the same pack', async () => {
    const [a] = memberIds(1);
    const created = await createPack([a]);
    expect(created.status).toBe(201);
    const packId = String(created.body.id);

    // Deliberately bypassing the route: this is what a write path that forgot to
    // deduplicate would run into, and the reason the property does not depend on
    // every caller remembering it.
    //
    // Asserted on the driver error's `constraint`, not on the message: drizzle
    // wraps the failure in a `Failed query: …` string that names the statement
    // and NOT the constraint, so a message match would pass for a NOT NULL
    // violation, a check violation, or any other refused insert — it would say
    // "the write failed", which is not the claim being made here.
    const duplicate = await db
      .insert(starterPackMembers)
      .values({ packId, oxyUserId: a, position: 1 })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(duplicate, 'the second row for one account must be REFUSED').toBeDefined();
    const cause = (duplicate as { cause?: { code?: string; constraint_name?: string } }).cause;
    expect(cause?.code, 'a unique_violation, not some other refusal').toBe('23505');
    expect(cause?.constraint_name).toBe('starter_pack_members_pack_id_oxy_user_id_key');

    const surviving = await db
      .select({ id: starterPackMembers.id })
      .from(starterPackMembers)
      .where(and(eq(starterPackMembers.packId, packId), eq(starterPackMembers.oxyUserId, a)));
    expect(surviving).toHaveLength(1);
  });
});
