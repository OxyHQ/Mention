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
import type { OxyAuthRequest } from '@oxy.so/core/server';

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
import {
  ACCOUNT_LIST_MAX_MEMBERS,
  ACCOUNT_LIST_MAX_MEMBER_ID_LENGTH,
  accountListMembers,
  accountLists,
  starterPacks,
} from '../../db/schema/lists';
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

/**
 * `isPublic` used to be `z.unknown()` and written through `!!isPublic`, which
 * is TOTAL over any JSON value in the wrong way: `"false"` (a non-empty
 * string), `[]`, `{}` and any number but `0` are all truthy, so a client that
 * sent the STRING `"false"` meaning to keep a list private wrote `true`. A
 * real `z.boolean()` still accepts genuine `true`/`false` and now rejects
 * everything else outright rather than reinterpreting it.
 */
describe('POST/PUT /lists isPublic', () => {
  it.each([true, false])('a genuine boolean %s round-trips through POST', async (value) => {
    const res = await createList({ title: `Genuine ${value}`, isPublic: value });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(accountLists).where(eq(accountLists.id, res.body.id));
    expect(row.isPublic).toBe(value);
  });

  it.each([
    ['the string "false"', 'false'],
    ['the string "true"', 'true'],
    ['a number', 1],
    ['an empty array', []],
    ['an empty object', {}],
    ['null', null],
  ])('rejects %s instead of coercing it by truthiness', async (_label, value) => {
    const res = await createList({ title: `Rejects ${JSON.stringify(value)}`, isPublic: value });
    expect(res.status).toBe(400);
    const rows = await db
      .select({ title: accountLists.title })
      .from(accountLists)
      .where(eq(accountLists.ownerOxyUserId, VIEWER_ID));
    expect(rows.map((row) => row.title)).not.toContain(`Rejects ${JSON.stringify(value)}`);
  });

  it('defaults a POST that omits isPublic to true', async () => {
    const res = await createList({ title: 'Default visibility' });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(accountLists).where(eq(accountLists.id, res.body.id));
    expect(row.isPublic).toBe(true);
  });

  it('flips a real boolean on PUT in both directions', async () => {
    const created = await createList({ title: 'Flippable', isPublic: true });

    await request(app).put(`/lists/${created.body.id}`).send({ isPublic: false }).expect(200);
    let [row] = await db.select().from(accountLists).where(eq(accountLists.id, created.body.id));
    expect(row.isPublic).toBe(false);

    await request(app).put(`/lists/${created.body.id}`).send({ isPublic: true }).expect(200);
    [row] = await db.select().from(accountLists).where(eq(accountLists.id, created.body.id));
    expect(row.isPublic).toBe(true);
  });

  it('omitting isPublic on PUT preserves the stored value', async () => {
    const created = await createList({ title: 'Untouched', isPublic: false });

    await request(app).put(`/lists/${created.body.id}`).send({ title: 'Untouched renamed' }).expect(200);

    const [row] = await db.select().from(accountLists).where(eq(accountLists.id, created.body.id));
    expect(row.isPublic).toBe(false);
    expect(row.title).toBe('Untouched renamed');
  });

  it('rejects a non-boolean isPublic on PUT without touching the stored value', async () => {
    const created = await createList({ title: 'Guarded', isPublic: false });

    const res = await request(app).put(`/lists/${created.body.id}`).send({ isPublic: 'false' });

    expect(res.status).toBe(400);
    const [row] = await db.select().from(accountLists).where(eq(accountLists.id, created.body.id));
    expect(row.isPublic).toBe(false);
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

/**
 * `normalizeMemberIds` deduplicated and dropped non-string entries but never
 * bounded HOW MANY members a list could hold or how long one member's id
 * could be. Neither bound is new client-visible validation surface exactly:
 * the length bound drops a value the same way an object or a number always
 * has (nothing real is anywhere near it), while the count bound is a genuine
 * new 400 — a list this large was never a value `normalizeMemberIds` could
 * have silently produced by accident.
 */
describe('POST/PUT /lists member bounds', () => {
  it(`refuses to create a list with more than ${ACCOUNT_LIST_MAX_MEMBERS} members`, async () => {
    const memberOxyUserIds = Array.from({ length: ACCOUNT_LIST_MAX_MEMBERS + 1 }, (_, i) => `member-${i}`);

    const res = await createList({ title: 'Too big', memberOxyUserIds });

    expect(res.status).toBe(400);
    const rows = await db
      .select({ title: accountLists.title })
      .from(accountLists)
      .where(eq(accountLists.ownerOxyUserId, VIEWER_ID));
    expect(rows.map((row) => row.title)).not.toContain('Too big');
  });

  it(`refuses a PUT that would grow a list past ${ACCOUNT_LIST_MAX_MEMBERS} members`, async () => {
    const created = await createList({ title: 'Grows too big', memberOxyUserIds: ['seed'] });
    const memberOxyUserIds = Array.from({ length: ACCOUNT_LIST_MAX_MEMBERS + 1 }, (_, i) => `member-${i}`);

    const res = await request(app).put(`/lists/${created.body.id}`).send({ memberOxyUserIds });

    expect(res.status).toBe(400);
    const rows = await db
      .select({ oxyUserId: accountListMembers.oxyUserId })
      .from(accountListMembers)
      .where(eq(accountListMembers.listId, created.body.id));
    expect(rows.map((row) => row.oxyUserId)).toEqual(['seed']);
  });

  it(`refuses a members-add that would grow a list past ${ACCOUNT_LIST_MAX_MEMBERS}`, async () => {
    const created = await createList({ title: 'Add too many' });
    const userIds = Array.from({ length: ACCOUNT_LIST_MAX_MEMBERS + 1 }, (_, i) => `member-${i}`);

    const res = await request(app).post(`/lists/${created.body.id}/members`).send({ userIds });

    expect(res.status).toBe(400);
    const rows = await db
      .select({ oxyUserId: accountListMembers.oxyUserId })
      .from(accountListMembers)
      .where(eq(accountListMembers.listId, created.body.id));
    expect(rows).toEqual([]);
  });

  it('silently drops a member id past the length bound, keeping the rest', async () => {
    const tooLong = 'x'.repeat(ACCOUNT_LIST_MAX_MEMBER_ID_LENGTH + 1);

    const res = await createList({
      title: 'Has one bad id',
      memberOxyUserIds: ['real-member', tooLong],
    });

    expect(res.status).toBe(201);
    const rows = await db
      .select({ oxyUserId: accountListMembers.oxyUserId })
      .from(accountListMembers)
      .where(eq(accountListMembers.listId, res.body.id));
    expect(rows.map((row) => row.oxyUserId)).toEqual(['real-member']);
  });
});
