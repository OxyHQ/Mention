/**
 * A federated-source starter pack is read-only, asserted against real rows.
 *
 * A pack mirrored from atproto is owned UPSTREAM: its name and membership are
 * re-synced in place on every profile view, so a local edit would be silently
 * overwritten on the next sync. Every mutation route rejects it with 403 BEFORE
 * the ownership check, so it is never editable regardless of who asks; following
 * its members (`POST /:id/use`) stays allowed, because that is a viewer action
 * that mutates nothing about the pack.
 *
 * The suite this replaces stubbed `StarterPack.findById` and asserted that a
 * `save` spy had not been called. With real rows the assertion is what it should
 * always have been: the ROW is unchanged afterwards.
 *
 * The source subdocument is also the schema's one SPARSE-UNIQUE column, so the
 * round-trip of `{network, uri, syncedAt}` is checked here too — flattened into
 * three columns, they could quietly stop arriving together.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

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
import { starterPackMembers, starterPacks } from '../../db/schema/lists';
import starterPacksRoutes from '../../routes/starterPacks';

const READONLY_MESSAGE = 'This starter pack is mirrored from an external network and is read-only';

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

const SYNCED_AT = new Date(Date.UTC(2026, 3, 4, 5, 6, 7));

async function seedFederatedPack(ownerOxyUserId = `oxy-federated-owner-${run}`): Promise<string> {
  const [pack] = await db
    .insert(starterPacks)
    .values({
      ownerOxyUserId,
      name: 'Bluesky pack',
      sourceNetwork: 'atproto',
      sourceUri: `at://did:plc:x/app.bsky.graph.starterpack/${randomUUID()}`,
      sourceSyncedAt: SYNCED_AT,
    })
    .returning({ id: starterPacks.id });
  createdPackIds.push(pack.id);
  await db.insert(starterPackMembers).values([
    { packId: pack.id, oxyUserId: 'a', position: 0 },
    { packId: pack.id, oxyUserId: 'b', position: 1 },
  ]);
  return pack.id;
}

async function seedNativePack(ownerOxyUserId: string): Promise<string> {
  const [pack] = await db
    .insert(starterPacks)
    .values({ ownerOxyUserId, name: 'Native pack' })
    .returning({ id: starterPacks.id });
  createdPackIds.push(pack.id);
  return pack.id;
}

async function readPack(packId: string) {
  const [row] = await db.select().from(starterPacks).where(eq(starterPacks.id, packId));
  const members = await db
    .select({ oxyUserId: starterPackMembers.oxyUserId })
    .from(starterPackMembers)
    .where(eq(starterPackMembers.packId, packId));
  return { row, memberIds: members.map((member) => member.oxyUserId) };
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

describe('federated starter pack is read-only', () => {
  it.each([
    ['put', '', { name: 'hacked' }],
    ['post', '/members', { userIds: ['c'] }],
    ['delete', '/members', { userIds: ['a'] }],
    ['delete', '', {}],
  ] as const)('rejects %s /:id%s with 403 read-only, and the row is unchanged', async (method, suffix, body) => {
    const packId = await seedFederatedPack();
    const before = await readPack(packId);

    const res = await request(app)[method](`/starter-packs/${packId}${suffix}`).send(body);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(READONLY_MESSAGE);
    const after = await readPack(packId);
    expect(after.row.name).toBe(before.row.name);
    expect(after.row.updatedAt.getTime()).toBe(before.row.updatedAt.getTime());
    expect(after.memberIds).toEqual(['a', 'b']);
  });

  it('rejects the federated pack before the ownership check, even for its own owner', async () => {
    // Read-only wins over "Not allowed" — the pack is never editable by anyone,
    // so the check must run BEFORE ownership, not after it.
    const packId = await seedFederatedPack(VIEWER_ID);

    const res = await request(app).put(`/starter-packs/${packId}`).send({ name: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe(READONLY_MESSAGE);
  });

  it('still lets a viewer USE a federated pack', async () => {
    const packId = await seedFederatedPack();

    const res = await request(app).post(`/starter-packs/${packId}/use`).expect(200);

    expect(res.body).toEqual({ memberOxyUserIds: ['a', 'b'], useCount: 1 });
  });

  it('round-trips the source subdocument the three columns replaced', async () => {
    const packId = await seedFederatedPack();

    const res = await request(app).get(`/starter-packs/${packId}`).expect(200);

    expect(res.body.source).toEqual({
      network: 'atproto',
      uri: expect.stringContaining('at://did:plc:x/app.bsky.graph.starterpack/'),
      syncedAt: SYNCED_AT.toISOString(),
    });
  });
});

describe('native starter pack is unaffected by the federated guard', () => {
  it('still applies the normal ownership check (403 Not allowed, not the read-only message)', async () => {
    const packId = await seedNativePack(`some-other-owner-${run}`);

    const res = await request(app).put(`/starter-packs/${packId}`).send({ name: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Not allowed');
  });

  it('omits `source` entirely rather than sending nulls', async () => {
    /**
     * Mongoose left an absent subdocument `undefined`, which `JSON.stringify`
     * drops. Three nullable columns would otherwise serialize as
     * `"source": {network: null, …}` — a different body for the same absent
     * value, and one an `if (pack.source)` guard reads as "federated".
     */
    const packId = await seedNativePack(VIEWER_ID);

    const res = await request(app).get(`/starter-packs/${packId}`).expect(200);

    expect(res.body).not.toHaveProperty('source');
  });

  it('is editable by its owner', async () => {
    const packId = await seedNativePack(VIEWER_ID);

    const res = await request(app).put(`/starter-packs/${packId}`).send({ name: 'renamed' }).expect(200);

    expect(res.body.name).toBe('renamed');
    expect((await readPack(packId)).row.name).toBe('renamed');
  });
});
