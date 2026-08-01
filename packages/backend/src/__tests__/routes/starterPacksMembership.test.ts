/**
 * Starter-pack MEMBERSHIP — the structural half of the port, against real rows.
 *
 * `memberOxyUserIds: [String]` became `starter_pack_members`, a junction whose
 * `position` column carries the arrangement the owner chose and whose
 * `(pack_id, position)` UNIQUE constraint makes an in-place reorder impossible.
 * Three things therefore need proving, and none of them existed before because
 * the array made all three free:
 *
 *  - the order a client sends is the order that comes back, on every route;
 *  - a REORDER really works, rather than colliding with the row that still holds
 *    the target position;
 *  - the 150-member cap is still enforced by the write API — the schema does not
 *    express it, so nothing else will.
 *
 * `usedByOxyUserIds` became `starter_pack_uses`, and `POST /:id/use` now leans on
 * that junction's unique constraint for its once-per-viewer guarantee instead of
 * a `$ne` filter on an array. And `source_uri` is a SPARSE unique index, so every
 * write path here must leave it NULL rather than `''` — an empty string is a
 * VALUE, and every locally created pack would collide with every other one.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn().mockResolvedValue(new Map()),
  isFallbackUserSummary: vi.fn().mockReturnValue(false),
}));
vi.mock('../../services/userSummaryCache', () => ({ invalidate: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/EndorsementSignalService', () => ({
  endorsementSignalService: {
    syncScope: vi.fn().mockResolvedValue(undefined),
    syncScopeMembershipChange: vi.fn().mockResolvedValue(undefined),
    syncScopeRemoval: vi.fn().mockResolvedValue(undefined),
  },
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import {
  STARTER_PACK_MAX_MEMBERS,
  starterPackMembers,
  starterPackUses,
  starterPacks,
} from '../../db/schema/lists';
import starterPacksRoutes from '../../routes/starterPacks';

let db: Database;
const run = randomUUID();
const VIEWER_ID = `viewer-${run}`;
const createdPackIds: string[] = [];

let authUserId: string | undefined = VIEWER_ID;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string } }).user = authUserId ? { id: authUserId } : undefined;
  next();
});
app.use('/starter-packs', starterPacksRoutes);

/** Create a pack through the ROUTE, so every assertion covers a real write path. */
async function createPack(body: Record<string, unknown>): Promise<request.Response> {
  const res = await request(app).post('/starter-packs').send({ name: `Pack ${randomUUID()}`, ...body });
  if (res.status === 201) createdPackIds.push(res.body.id);
  return res;
}

/** The junction rows for a pack, in stored position order. */
async function readMemberRows(packId: string): Promise<Array<{ oxyUserId: string; position: number }>> {
  return db
    .select({ oxyUserId: starterPackMembers.oxyUserId, position: starterPackMembers.position })
    .from(starterPackMembers)
    .where(eq(starterPackMembers.packId, packId))
    .orderBy(asc(starterPackMembers.position));
}

function memberIds(rows: Array<{ oxyUserId: string }>): string[] {
  return rows.map((row) => row.oxyUserId);
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  authUserId = VIEWER_ID;
  if (createdPackIds.length > 0) {
    await db.delete(starterPacks).where(inArray(starterPacks.id, createdPackIds));
    createdPackIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('membership order survives the junction', () => {
  it('stores the order the client sent, with contiguous positions', async () => {
    const res = await createPack({ memberOxyUserIds: ['charlie', 'alpha', 'bravo'] });

    expect(res.status).toBe(201);
    expect(res.body.memberOxyUserIds).toEqual(['charlie', 'alpha', 'bravo']);
    expect(await readMemberRows(res.body.id)).toEqual([
      { oxyUserId: 'charlie', position: 0 },
      { oxyUserId: 'alpha', position: 1 },
      { oxyUserId: 'bravo', position: 2 },
    ]);
  });

  it('reads the same order back from the detail route', async () => {
    const created = await createPack({ memberOxyUserIds: ['charlie', 'alpha', 'bravo'] });

    const res = await request(app).get(`/starter-packs/${created.body.id}`).expect(200);

    expect(res.body.memberOxyUserIds).toEqual(['charlie', 'alpha', 'bravo']);
    expect(res.body.memberCount).toBe(3);
  });

  it('collapses a duplicate id the array used to keep twice', async () => {
    // `(pack_id, oxy_user_id)` is UNIQUE, so a repeated id is not storable; the
    // FIRST occurrence wins, which is what preserves the owner's arrangement.
    const res = await createPack({ memberOxyUserIds: ['a', 'b', 'a', 'c'] });

    expect(res.body.memberOxyUserIds).toEqual(['a', 'b', 'c']);
  });

  it('drops a non-string member id rather than storing "[object Object]"', async () => {
    const res = await createPack({ memberOxyUserIds: ['a', { $ne: null }, 42, '', 'b'] });

    expect(res.status).toBe(201);
    expect(res.body.memberOxyUserIds).toEqual(['a', 'b']);
  });

  it('REORDERS an existing membership without colliding on (pack_id, position)', async () => {
    /**
     * THE structural test. `(pack_id, position)` is UNIQUE and Postgres checks a
     * unique constraint per STATEMENT, so shifting positions in place — even in
     * one multi-row `UPDATE` — fails against the rows that still hold them. The
     * route deletes then re-inserts, in that order, inside one transaction.
     */
    const created = await createPack({ memberOxyUserIds: ['a', 'b', 'c', 'd'] });

    const res = await request(app)
      .put(`/starter-packs/${created.body.id}`)
      .send({ memberOxyUserIds: ['d', 'c', 'b', 'a'] })
      .expect(200);

    expect(res.body.memberOxyUserIds).toEqual(['d', 'c', 'b', 'a']);
    expect(await readMemberRows(created.body.id)).toEqual([
      { oxyUserId: 'd', position: 0 },
      { oxyUserId: 'c', position: 1 },
      { oxyUserId: 'b', position: 2 },
      { oxyUserId: 'a', position: 3 },
    ]);
  });

  it('swaps exactly two adjacent members — the tightest position collision', async () => {
    const created = await createPack({ memberOxyUserIds: ['a', 'b'] });

    const res = await request(app)
      .put(`/starter-packs/${created.body.id}`)
      .send({ memberOxyUserIds: ['b', 'a'] })
      .expect(200);

    expect(res.body.memberOxyUserIds).toEqual(['b', 'a']);
  });

  it('appends new members and leaves the existing order alone', async () => {
    const created = await createPack({ memberOxyUserIds: ['a', 'b'] });

    const res = await request(app)
      .post(`/starter-packs/${created.body.id}/members`)
      .send({ userIds: ['c', 'a', 'd'] })
      .expect(200);

    expect(res.body.memberOxyUserIds).toEqual(['a', 'b', 'c', 'd']);
    expect(await readMemberRows(created.body.id)).toEqual([
      { oxyUserId: 'a', position: 0 },
      { oxyUserId: 'b', position: 1 },
      { oxyUserId: 'c', position: 2 },
      { oxyUserId: 'd', position: 3 },
    ]);
  });

  it('removes members and re-closes the position gap they left', async () => {
    const created = await createPack({ memberOxyUserIds: ['a', 'b', 'c', 'd'] });

    const res = await request(app)
      .delete(`/starter-packs/${created.body.id}/members`)
      .send({ userIds: ['b', 'd'] })
      .expect(200);

    expect(res.body.memberOxyUserIds).toEqual(['a', 'c']);
    expect(await readMemberRows(created.body.id)).toEqual([
      { oxyUserId: 'a', position: 0 },
      { oxyUserId: 'c', position: 1 },
    ]);
  });

  it('leaves membership untouched when a PUT does not mention it', async () => {
    const created = await createPack({ memberOxyUserIds: ['a', 'b'] });

    const res = await request(app)
      .put(`/starter-packs/${created.body.id}`)
      .send({ name: 'renamed' })
      .expect(200);

    expect(res.body.name).toBe('renamed');
    expect(res.body.memberOxyUserIds).toEqual(['a', 'b']);
  });

  it('empties a membership when asked to, without leaving orphan rows', async () => {
    const created = await createPack({ memberOxyUserIds: ['a', 'b'] });

    const res = await request(app)
      .put(`/starter-packs/${created.body.id}`)
      .send({ memberOxyUserIds: [] })
      .expect(200);

    expect(res.body.memberOxyUserIds).toEqual([]);
    expect(await readMemberRows(created.body.id)).toEqual([]);
  });
});

describe('the 150-member cap is enforced by the write API', () => {
  const atCap = Array.from({ length: STARTER_PACK_MAX_MEMBERS }, (_, i) => `m${String(i).padStart(3, '0')}`);
  const overCap = [...atCap, 'one-too-many'];
  const capMessage = `Maximum ${STARTER_PACK_MAX_MEMBERS} members allowed`;

  it('accepts a pack created exactly AT the cap', async () => {
    const res = await createPack({ memberOxyUserIds: atCap });

    expect(res.status).toBe(201);
    expect(res.body.memberOxyUserIds).toHaveLength(STARTER_PACK_MAX_MEMBERS);
  });

  it('rejects the 151st member at creation, and writes no pack at all', async () => {
    const before = await countPacksOwnedByViewer();

    const res = await createPack({ memberOxyUserIds: overCap });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(capMessage);
    expect(await countPacksOwnedByViewer()).toBe(before);
  });

  it('rejects the 151st member on update, leaving the membership as it was', async () => {
    const created = await createPack({ memberOxyUserIds: ['a'] });

    const res = await request(app)
      .put(`/starter-packs/${created.body.id}`)
      .send({ memberOxyUserIds: overCap });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(capMessage);
    expect(memberIds(await readMemberRows(created.body.id))).toEqual(['a']);
  });

  it('rejects the 151st member when ADDING to a pack already at the cap', async () => {
    const created = await createPack({ memberOxyUserIds: atCap });

    const res = await request(app)
      .post(`/starter-packs/${created.body.id}/members`)
      .send({ userIds: ['one-too-many'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(capMessage);
    expect(await readMemberRows(created.body.id)).toHaveLength(STARTER_PACK_MAX_MEMBERS);
  });

  it('still accepts an add that only re-sends members already in the pack', async () => {
    // The cap is on the RESULTING set, not on the request: re-adding an existing
    // member cannot push a full pack over the line.
    const created = await createPack({ memberOxyUserIds: atCap });

    const res = await request(app)
      .post(`/starter-packs/${created.body.id}/members`)
      .send({ userIds: [atCap[0], atCap[1]] });

    expect(res.status).toBe(200);
    expect(res.body.memberOxyUserIds).toHaveLength(STARTER_PACK_MAX_MEMBERS);
  });
});

describe('POST /:id/use — the junction is the idempotency key', () => {
  it('counts a first use and reports the members to follow', async () => {
    const created = await createPack({ memberOxyUserIds: ['a', 'b'] });

    const res = await request(app).post(`/starter-packs/${created.body.id}/use`).expect(200);

    expect(res.body).toEqual({ memberOxyUserIds: ['a', 'b'], useCount: 1 });
    expect(res.body).not.toHaveProperty('alreadyUsed');
  });

  it('does not re-count a second use by the same viewer', async () => {
    const created = await createPack({ memberOxyUserIds: ['a'] });
    await request(app).post(`/starter-packs/${created.body.id}/use`).expect(200);

    const res = await request(app).post(`/starter-packs/${created.body.id}/use`).expect(200);

    expect(res.body).toEqual({ memberOxyUserIds: ['a'], useCount: 1, alreadyUsed: true });
    // One row, not two — and the counter matches its cardinality.
    const uses = await db
      .select({ oxyUserId: starterPackUses.oxyUserId })
      .from(starterPackUses)
      .where(eq(starterPackUses.packId, created.body.id));
    expect(uses).toEqual([{ oxyUserId: VIEWER_ID }]);
  });

  it('counts a different viewer separately', async () => {
    const created = await createPack({ memberOxyUserIds: ['a'] });
    await request(app).post(`/starter-packs/${created.body.id}/use`).expect(200);

    authUserId = `second-viewer-${run}`;
    const res = await request(app).post(`/starter-packs/${created.body.id}/use`).expect(200);

    expect(res.body.useCount).toBe(2);
  });

  it('404s a pack that does not exist, and records nothing', async () => {
    const res = await request(app).post(`/starter-packs/${randomUUID()}/use`);

    expect(res.status).toBe(404);
  });
});

describe('wire format parity', () => {
  it('emits _id alongside id', async () => {
    const res = await createPack({ memberOxyUserIds: [] });

    expect(res.body._id).toBe(res.body.id);
    expect(res.body.useCount).toBe(0);
    expect(res.body.ownerOxyUserId).toBe(VIEWER_ID);
  });

  it('OMITS an absent description rather than sending null', async () => {
    /**
     * Mongoose left `description` `undefined`, which `JSON.stringify` drops.
     * Drizzle hands back `null`, which serializes as `"description": null` — a
     * different response body for the same absent value, and the exact shape a
     * client `if (pack.description)` check would start rendering as empty.
     */
    const res = await createPack({});

    expect('description' in res.body).toBe(false);
    expect(JSON.parse(JSON.stringify(res.body))).not.toHaveProperty('description');
  });

  it('writes source_uri as NULL, never an empty string', async () => {
    /**
     * `starter_packs_source_uri_key` is a PARTIAL unique index over non-null
     * `source_uri`. An empty string is a VALUE, so a second locally created pack
     * would collide with the first — converting a non-problem into a live 500 on
     * every create after the first one.
     */
    const first = await createPack({});
    const second = await createPack({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const rows = await db
      .select({
        sourceUri: starterPacks.sourceUri,
        sourceNetwork: starterPacks.sourceNetwork,
        sourceSyncedAt: starterPacks.sourceSyncedAt,
      })
      .from(starterPacks)
      .where(inArray(starterPacks.id, [first.body.id, second.body.id]));
    expect(rows).toEqual([
      { sourceUri: null, sourceNetwork: null, sourceSyncedAt: null },
      { sourceUri: null, sourceNetwork: null, sourceSyncedAt: null },
    ]);
  });

  it('deletes a pack along with its members and uses', async () => {
    const created = await createPack({ memberOxyUserIds: ['a', 'b'] });
    await request(app).post(`/starter-packs/${created.body.id}/use`).expect(200);

    await request(app).delete(`/starter-packs/${created.body.id}`).expect(200);

    expect(await readMemberRows(created.body.id)).toEqual([]);
    const uses = await db
      .select({ id: starterPackUses.id })
      .from(starterPackUses)
      .where(eq(starterPackUses.packId, created.body.id));
    expect(uses).toEqual([]);
  });

  it('404s a pack id that names nothing, whatever its shape', async () => {
    /**
     * There is no id-shape guard left: a `text` primary key that matches no row
     * already answers "no such pack", and a guard that rejected anything but
     * 24-hex would have hidden every pack created after the cutover.
     */
    for (const id of [randomUUID(), 'not-an-id-at-all']) {
      await request(app).get(`/starter-packs/${id}`).expect(404);
    }
  });
});

async function countPacksOwnedByViewer(): Promise<number> {
  const rows = await db
    .select({ id: starterPacks.id })
    .from(starterPacks)
    .where(eq(starterPacks.ownerOxyUserId, VIEWER_ID));
  return rows.length;
}
