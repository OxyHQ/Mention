/**
 * The two text fields a list and a starter pack own, in both directions.
 *
 * `title` / `name` were tested for TRUTHINESS and then written through
 * `String(value)`, so `{}` became the literal `"[object Object]"` and `[1,2]`
 * became `"1,2"` — a 201, a persisted row, and nothing to tell anybody it had
 * happened. The PUT was worse: it branched on `value === undefined`, so a
 * `null` wrote the four-character string `"null"` OVER a real title, and `''`
 * wrote an empty one the POST refuses.
 *
 * `description` had the same coercion.
 *
 * The bodies the frontend's own `ListWriteBody` / `StarterPackWriteBody` types
 * describe are all still accepted, including a `description: ''` that clears the
 * column to NULL rather than storing an empty string.
 */

import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxyhq/core/server';

vi.mock('../../controllers/feed.controller', () => ({
  feedController: { transformPostsWithProfiles: vi.fn(async () => []) },
}));
vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: vi.fn(async () => new Map()),
  isFallbackUserSummary: vi.fn(() => false),
}));
vi.mock('../../services/userSummaryCache', () => ({ invalidate: vi.fn(async () => undefined) }));
vi.mock('../../services/EndorsementSignalService', () => ({
  endorsementSignalService: {
    syncScope: vi.fn().mockResolvedValue(undefined),
    syncScopeMembershipChange: vi.fn().mockResolvedValue(undefined),
    syncScopeRemoval: vi.fn().mockResolvedValue(undefined),
  },
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { accountLists, starterPacks } from '../../db/schema/lists';
import listRoutes from '../../routes/lists';
import starterPacksRoutes from '../../routes/starterPacks';

let db: Database;
const VIEWER_ID = `viewer-${randomUUID()}`;
const createdListIds: string[] = [];
const createdPackIds: string[] = [];

const app = express();
app.use(express.json());
app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
  req.user = { id: VIEWER_ID };
  next();
});
app.use('/lists', listRoutes);
app.use('/starter-packs', starterPacksRoutes);

async function createList(body: Record<string, unknown>): Promise<request.Response> {
  const res = await request(app).post('/lists').send(body);
  if (res.status === 201) createdListIds.push(res.body.id);
  return res;
}

async function createPack(body: Record<string, unknown>): Promise<request.Response> {
  const res = await request(app).post('/starter-packs').send(body);
  if (res.status === 201) createdPackIds.push(res.body.id);
  return res;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  if (createdListIds.length > 0) {
    await db.delete(accountLists).where(inArray(accountLists.id, createdListIds));
    createdListIds.length = 0;
  }
  if (createdPackIds.length > 0) {
    await db.delete(starterPacks).where(inArray(starterPacks.id, createdPackIds));
    createdPackIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('POST/PUT /lists title and description', () => {
  it('still accepts the write body the lists screen sends', async () => {
    const res = await createList({
      title: 'Reading list',
      description: 'things to read',
      isPublic: false,
      memberOxyUserIds: ['alpha', 'bravo'],
    });

    expect(res.status).toBe(201);
    const [row] = await db.select().from(accountLists).where(eq(accountLists.id, res.body.id));
    expect(row.title).toBe('Reading list');
    expect(row.description).toBe('things to read');
    expect(row.isPublic).toBe(false);
  });

  it('still stores NULL, not an empty string, for a blank description', async () => {
    const res = await createList({ title: 'No blurb', description: '' });

    expect(res.status).toBe(201);
    const [row] = await db.select().from(accountLists).where(eq(accountLists.id, res.body.id));
    expect(row.description).toBeNull();
  });

  it('still refuses a missing title', async () => {
    const res = await createList({ description: 'orphan' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Title is required');
  });

  it('refuses an object title instead of persisting "[object Object]"', async () => {
    const res = await createList({ title: { $ne: null } });

    expect(res.status).toBe(400);
    const rows = await db
      .select({ title: accountLists.title })
      .from(accountLists)
      .where(eq(accountLists.ownerOxyUserId, VIEWER_ID));
    expect(rows.map((row) => row.title)).not.toContain('[object Object]');
  });

  it('refuses a null title on PUT instead of writing the string "null" over a real one', async () => {
    const created = await createList({ title: 'Keep me' });
    expect(created.status).toBe(201);

    const res = await request(app).put(`/lists/${created.body.id}`).send({ title: null });

    expect(res.status).toBe(400);
    const [row] = await db.select().from(accountLists).where(eq(accountLists.id, created.body.id));
    expect(row.title).toBe('Keep me');
  });

  it('still applies a legitimate PUT, leaving the fields it does not name alone', async () => {
    const created = await createList({ title: 'Before', description: 'blurb' });

    const res = await request(app).put(`/lists/${created.body.id}`).send({ title: 'After' });

    expect(res.status).toBe(200);
    const [row] = await db.select().from(accountLists).where(eq(accountLists.id, created.body.id));
    expect(row.title).toBe('After');
    expect(row.description).toBe('blurb');
  });
});

describe('POST/PUT /starter-packs name and description', () => {
  it('still accepts the write body the create screen sends', async () => {
    const res = await createPack({
      name: 'Starter set',
      description: 'people to follow',
      memberOxyUserIds: ['alpha'],
    });

    expect(res.status).toBe(201);
    const [row] = await db.select().from(starterPacks).where(eq(starterPacks.id, res.body.id));
    expect(row.name).toBe('Starter set');
    expect(row.description).toBe('people to follow');
    // A locally created pack must leave `source_uri` NULL — it is a PARTIAL
    // unique index, so `''` would collide every pack with every other one.
    expect(row.sourceUri).toBeNull();
  });

  it('still refuses a missing name', async () => {
    const res = await createPack({ description: 'orphan' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Name is required');
  });

  it('refuses an array name instead of persisting its comma-joined coercion', async () => {
    const res = await createPack({ name: ['a', 'b'] });

    expect(res.status).toBe(400);
    const rows = await db
      .select({ name: starterPacks.name })
      .from(starterPacks)
      .where(eq(starterPacks.ownerOxyUserId, VIEWER_ID));
    expect(rows.map((row) => row.name)).not.toContain('a,b');
  });

  it('refuses a null name on PUT instead of writing the string "null" over a real one', async () => {
    const created = await createPack({ name: 'Keep me' });
    expect(created.status).toBe(201);

    const res = await request(app).put(`/starter-packs/${created.body.id}`).send({ name: null });

    expect(res.status).toBe(400);
    const [row] = await db.select().from(starterPacks).where(eq(starterPacks.id, created.body.id));
    expect(row.name).toBe('Keep me');
  });

  it('still applies a legitimate PUT', async () => {
    const created = await createPack({ name: 'Before', description: 'blurb' });

    const res = await request(app).put(`/starter-packs/${created.body.id}`).send({ name: 'After' });

    expect(res.status).toBe(200);
    const [row] = await db.select().from(starterPacks).where(eq(starterPacks.id, created.body.id));
    expect(row.name).toBe('After');
    expect(row.description).toBe('blurb');
  });
});
