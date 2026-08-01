/**
 * `GET /starter-packs`, against real rows.
 *
 * The suite this replaces ran the route over a hand-written in-memory Mongo
 * stand-in and, for the property that actually matters, asserted the SORT SPEC
 * OBJECT — `Object.keys(sortSpecs[0]).at(-1) === '_id'`. That check cannot fail
 * for a query that returns the wrong rows, and it cannot survive the port at all
 * (there is no sort spec any more). Offset pagination is only safe on a TOTAL
 * order, so the ordering tests below seed rows that TIE on every other key and
 * assert the exact sequence that comes back.
 *
 * Covered: `?page`/`?limit` offset pagination, a truthful `total` (the match
 * count, not the page length), `?search=` narrowing over name + description with
 * LIKE wildcards treated as literals, and `?excludeUsed=true` — the one
 * correlated subquery in this route, and therefore the one place a predicate can
 * silently match nothing.
 */

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';

// The collaborators the router imports for identity resolution, cache eviction
// and endorsement sync. All three reach outside this batch (Oxy over HTTP, Redis,
// the endorsement outbox), and none of them is the code under test.
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
import { starterPackMembers, starterPackUses, starterPacks } from '../../db/schema/lists';
import starterPackRoutes from '../../routes/starterPacks';

let db: Database;

const run = randomUUID();
const VIEWER_ID = `viewer-${run}`;
const OWNER_ID = `owner-${run}`;
const createdPackIds: string[] = [];

let authUserId: string | undefined = VIEWER_ID;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user?: { id: string } }).user = authUserId ? { id: authUserId } : undefined;
  next();
});
app.use('/starter-packs', starterPackRoutes);

interface SeedOptions {
  name?: string;
  description?: string;
  ownerOxyUserId?: string;
  useCount?: number;
  createdAt?: Date;
  updatedAt?: Date;
  id?: string;
  members?: string[];
  usedBy?: string[];
}

async function seedPack(options: SeedOptions = {}): Promise<string> {
  const [pack] = await db
    .insert(starterPacks)
    .values({
      ...(options.id === undefined ? {} : { id: options.id }),
      ownerOxyUserId: options.ownerOxyUserId ?? OWNER_ID,
      name: options.name ?? `Pack ${randomUUID()}`,
      description: options.description ?? null,
      useCount: options.useCount ?? 0,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
    })
    .returning({ id: starterPacks.id });
  createdPackIds.push(pack.id);

  const members = options.members ?? [];
  if (members.length > 0) {
    await db.insert(starterPackMembers).values(
      members.map((oxyUserId, position) => ({ packId: pack.id, oxyUserId, position })),
    );
  }
  const usedBy = options.usedBy ?? [];
  if (usedBy.length > 0) {
    await db.insert(starterPackUses).values(
      usedBy.map((oxyUserId) => ({ packId: pack.id, oxyUserId })),
    );
  }
  return pack.id;
}

/** `?search=` matches only these, so a shared prefix scopes each test's rows. */
function scopedName(label: string): string {
  return `${label} ${run}`;
}

function names(body: { items: Array<{ name: string }> }): string[] {
  return body.items.map((item) => item.name);
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  authUserId = VIEWER_ID;
  if (createdPackIds.length > 0) {
    // Members and uses cascade with the pack.
    await db.delete(starterPacks).where(inArray(starterPacks.id, createdPackIds));
    createdPackIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /starter-packs — pagination', () => {
  /** 60 packs — more than the default page — every one matching the run tag. */
  async function seedSixty(): Promise<void> {
    for (let index = 0; index < 60; index += 1) {
      await seedPack({
        name: scopedName(`Pack ${String(index).padStart(2, '0')}`),
        description: 'a curated set',
        // Descending creation time, so the discovery sort (all `useCount` 0) is
        // a plain chronological walk with a known answer.
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 60 - index)),
      });
    }
  }

  it('reports the real match count, not the page length', async () => {
    await seedSixty();

    const res = await request(app).get('/starter-packs').query({ search: run, limit: 10 }).expect(200);

    expect(res.body.items).toHaveLength(10);
    expect(res.body.total).toBe(60);
    expect(res.body).toMatchObject({ page: 1, totalPages: 6 });
    // A bigint `count(*)` comes back from the driver as a STRING; `total` must
    // stay the number the client has always parsed.
    expect(typeof res.body.total).toBe('number');
  });

  it('pages past the default window without repeating or skipping a row', async () => {
    await seedSixty();
    const seen: string[] = [];

    for (let page = 1; page <= 3; page += 1) {
      const res = await request(app)
        .get('/starter-packs')
        .query({ search: run, limit: 25, page })
        .expect(200);
      expect(res.body.page).toBe(page);
      seen.push(...names(res.body));
    }

    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
    // The third page reaches rows the un-paginated route could never return.
    expect(seen.at(-1)).toBe(scopedName('Pack 59'));
  });

  it('defaults to the window the route returned before it paginated', async () => {
    await seedSixty();

    const res = await request(app).get('/starter-packs').query({ search: run }).expect(200);

    expect(res.body.items).toHaveLength(50);
    expect(res.body.total).toBe(60);
  });

  it('clamps an oversized limit to the ceiling', async () => {
    await seedSixty();

    const res = await request(app).get('/starter-packs').query({ search: run, limit: 500 }).expect(200);

    expect(res.body.items).toHaveLength(60);
    expect(res.body.totalPages).toBe(1);
  });
});

/**
 * Offset pagination is only safe on a TOTAL order: rows that tie on every sort
 * key are free to swap places between two page requests, which duplicates one
 * and drops another at the boundary. Each case below seeds rows that tie on
 * EVERYTHING except the id, so the id tiebreak is the only thing deciding the
 * answer — remove it and the expected sequence is no longer produced.
 */
describe('GET /starter-packs — the sort is total', () => {
  const TIED = new Date(Date.UTC(2026, 5, 5, 12, 0, 0));
  /** Inserted in ASCENDING id order, so physical order is the reverse of correct. */
  const TIED_IDS = ['a', 'b', 'c', 'd'].map(
    (suffix) => `0198a2b1-4c3d-7e2f-8a1b-00000000000${suffix}`,
  );

  it('breaks a discovery tie (same useCount, same createdAt) by id, descending', async () => {
    for (const [index, id] of TIED_IDS.entries()) {
      await seedPack({ id, name: scopedName(`Tied ${index}`), useCount: 7, createdAt: TIED });
    }

    const res = await request(app).get('/starter-packs').query({ search: run }).expect(200);

    expect(names(res.body)).toEqual([
      scopedName('Tied 3'), scopedName('Tied 2'), scopedName('Tied 1'), scopedName('Tied 0'),
    ]);
  });

  it('breaks an owner-scoped tie (same updatedAt) by id, descending', async () => {
    for (const [index, id] of TIED_IDS.entries()) {
      await seedPack({
        id,
        name: scopedName(`Mine ${index}`),
        ownerOxyUserId: VIEWER_ID,
        updatedAt: TIED,
      });
    }

    const res = await request(app).get('/starter-packs').query({ mine: 'true' }).expect(200);

    expect(names(res.body)).toEqual([
      scopedName('Mine 3'), scopedName('Mine 2'), scopedName('Mine 1'), scopedName('Mine 0'),
    ]);
  });

  it('walks a tied set one row per page without repeating or skipping one', async () => {
    for (const [index, id] of TIED_IDS.entries()) {
      await seedPack({ id, name: scopedName(`Tied ${index}`), useCount: 7, createdAt: TIED });
    }

    const seen: string[] = [];
    for (let page = 1; page <= TIED_IDS.length; page += 1) {
      const res = await request(app)
        .get('/starter-packs')
        .query({ search: run, limit: 1, page })
        .expect(200);
      seen.push(...names(res.body));
    }

    expect(seen).toEqual([
      scopedName('Tied 3'), scopedName('Tied 2'), scopedName('Tied 1'), scopedName('Tied 0'),
    ]);
  });

  it('ranks discovery by useCount before recency', async () => {
    await seedPack({ name: scopedName('Popular'), useCount: 9, createdAt: new Date(Date.UTC(2020, 0, 1)) });
    await seedPack({ name: scopedName('Fresh'), useCount: 1, createdAt: new Date(Date.UTC(2026, 0, 1)) });

    const res = await request(app).get('/starter-packs').query({ search: run }).expect(200);

    expect(names(res.body)).toEqual([scopedName('Popular'), scopedName('Fresh')]);
  });
});

describe('GET /starter-packs — search', () => {
  it('narrows by search over name and description', async () => {
    await seedPack({ name: scopedName('Photographers'), description: '', useCount: 3 });
    await seedPack({ name: scopedName('Chefs'), description: `great photo accounts ${run}`, useCount: 2 });
    await seedPack({ name: scopedName('Cyclists'), description: 'road racing', useCount: 1 });

    const res = await request(app).get('/starter-packs').query({ search: `photo` }).expect(200);

    const found = names(res.body).filter((name) => name.includes(run));
    expect(found).toEqual([scopedName('Photographers'), scopedName('Chefs')]);
  });

  it('treats a LIKE wildcard in the search term as a literal', async () => {
    /**
     * The Mongo version escaped REGEX metacharacters; `%` and `_` are the ones
     * `ILIKE` reads as patterns, and leaving them live turns the search box into
     * a way to match every pack in the table.
     */
    await seedPack({ name: scopedName('Percent') });

    const wildcard = await request(app).get('/starter-packs').query({ search: '%' }).expect(200);
    expect(names(wildcard.body)).not.toContain(scopedName('Percent'));

    const literal = await request(app).get('/starter-packs').query({ search: `Percent ${run}` }).expect(200);
    expect(names(literal.body)).toEqual([scopedName('Percent')]);
  });
});

describe('GET /starter-packs — scoping modes', () => {
  it('returns nothing for an anonymous ?mine=true, without touching the database', async () => {
    authUserId = undefined;
    await seedPack({ name: scopedName('Somebody else'), ownerOxyUserId: OWNER_ID });

    const res = await request(app).get('/starter-packs').query({ mine: 'true' }).expect(200);

    expect(res.body).toEqual({ items: [], total: 0, page: 1, totalPages: 0 });
  });

  it("scopes to a named owner's packs", async () => {
    await seedPack({ name: scopedName('Theirs'), ownerOxyUserId: OWNER_ID });
    await seedPack({ name: scopedName('Mine'), ownerOxyUserId: VIEWER_ID });

    const res = await request(app).get('/starter-packs').query({ userId: OWNER_ID }).expect(200);

    expect(names(res.body)).toEqual([scopedName('Theirs')]);
  });

  it('carries memberAvatars and memberCount on every item', async () => {
    await seedPack({ name: scopedName('WithMembers'), members: ['m1', 'm2', 'm3'] });

    const res = await request(app).get('/starter-packs').query({ search: run }).expect(200);

    expect(res.body.items[0]).toMatchObject({
      memberCount: 3,
      memberOxyUserIds: ['m1', 'm2', 'm3'],
      // No summary resolves in this suite, so the avatar list is empty rather
      // than absent — the field itself must always be there.
      memberAvatars: [],
    });
  });
});

/**
 * `?excludeUsed=true` is the only CORRELATED subquery in this route, and a
 * correlated reference that renders unqualified compares two of the subquery's
 * OWN columns, matches nothing, and returns an empty result with no error at
 * all — the exact shape that shipped in the sibling oxy-api port. Every
 * assertion here enumerates a NON-EMPTY expected set.
 */
describe('GET /starter-packs — ?excludeUsed=true', () => {
  it('drops the packs the viewer used and keeps the ones they did not', async () => {
    await seedPack({ name: scopedName('Used'), useCount: 5, usedBy: [VIEWER_ID] });
    await seedPack({ name: scopedName('Unused'), useCount: 4 });
    await seedPack({ name: scopedName('UsedByOther'), useCount: 3, usedBy: [`somebody-${run}`] });

    const res = await request(app)
      .get('/starter-packs')
      .query({ search: run, excludeUsed: 'true' })
      .expect(200);

    // NON-EMPTY and exact: a predicate that silently matched nothing would give
    // `[]`, and a predicate that never fired would give all three.
    expect(names(res.body)).toEqual([scopedName('Unused'), scopedName('UsedByOther')]);
    expect(res.body.total).toBe(2);
  });

  it("drops the viewer's own packs too", async () => {
    await seedPack({ name: scopedName('Theirs'), useCount: 2 });
    await seedPack({ name: scopedName('Mine'), useCount: 1, ownerOxyUserId: VIEWER_ID });

    const res = await request(app)
      .get('/starter-packs')
      .query({ search: run, excludeUsed: 'true' })
      .expect(200);

    expect(names(res.body)).toEqual([scopedName('Theirs')]);
  });

  it('ignores the flag for an anonymous viewer, who has used nothing', async () => {
    authUserId = undefined;
    await seedPack({ name: scopedName('Used'), useCount: 5, usedBy: [VIEWER_ID] });
    await seedPack({ name: scopedName('Unused'), useCount: 4 });

    const res = await request(app)
      .get('/starter-packs')
      .query({ search: run, excludeUsed: 'true' })
      .expect(200);

    expect(names(res.body)).toEqual([scopedName('Used'), scopedName('Unused')]);
  });
});
