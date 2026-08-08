/**
 * `/lists`, driven through the real router against real rows.
 *
 * There was no suite for this route at all, and the port gives it three
 * properties that nothing else can check:
 *
 *  - `memberOxyUserIds` is now `account_list_members` with an explicit
 *    `position` and a `(list_id, position)` UNIQUE constraint, so the order the
 *    owner arranged has to survive every read and every write — and a REORDER
 *    has to work rather than colliding with the row that still holds the target
 *    position.
 *  - `GET /lists` is offset-paginated, which is only safe on a TOTAL order.
 *  - The visibility gate used to be SKIPPED whenever `mine` or `publicOnly` was
 *    present but not the literal `'true'`. `?mine=false` therefore produced an
 *    unfiltered query that returned every private list in the database, to any
 *    authenticated caller. That is closed here, and the case naming it is the
 *    reason this block exists.
 *
 * The timeline route reads POSTS, and those are real rows too. Only the
 * hydration behind them is stubbed — it is another suite's subject — and the
 * stub maps the records the QUERY returned, so an assertion about which posts a
 * timeline page contains is an assertion about the query.
 */

import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const mocks = vi.hoisted(() => ({
  transformPostsWithProfiles: vi.fn(),
}));

// Hydration belongs to another suite. The stub maps the records the real query
// returned rather than answering with a canned list, so which posts a timeline
// page contains stays a fact about the query.
vi.mock('../../controllers/feed.controller', () => ({
  feedController: { transformPostsWithProfiles: mocks.transformPostsWithProfiles },
}));
// The endorsement outbox is a fire-and-forget Oxy signal with its own queries.
vi.mock('../../services/EndorsementSignalService', () => ({
  endorsementSignalService: {
    syncScope: vi.fn().mockResolvedValue(undefined),
    syncScopeMembershipChange: vi.fn().mockResolvedValue(undefined),
    syncScopeRemoval: vi.fn().mockResolvedValue(undefined),
  },
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { accountListMembers, accountLists } from '../../db/schema/lists';
import { uuidv7 } from '../../db/schema/columns';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import listRoutes from '../../routes/lists';

const scope = postScope('lists-routes');

let db: Database;
const run = randomUUID();
const VIEWER_ID = `viewer-${run}`;
const OTHER_USER_ID = `stranger-${run}`;
const createdListIds: string[] = [];

let authUserId: string | undefined = VIEWER_ID;

const app = express();
app.use(express.json());
app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
  req.user = authUserId ? { id: authUserId } : undefined;
  next();
});
app.use('/lists', listRoutes);

/** Create a list through the ROUTE, so assertions cover a real write path. */
async function createList(body: Record<string, unknown> = {}): Promise<request.Response> {
  const res = await request(app).post('/lists').send({ title: `List ${randomUUID()}`, ...body });
  if (res.status === 201) createdListIds.push(res.body.id);
  return res;
}

/** Insert a list directly, for the cases that need a foreign owner or a fixed id. */
async function seedList(options: {
  title?: string;
  description?: string;
  isPublic?: boolean;
  ownerOxyUserId?: string;
  id?: string;
  updatedAt?: Date;
  members?: string[];
}): Promise<string> {
  const [list] = await db
    .insert(accountLists)
    .values({
      ...(options.id === undefined ? {} : { id: options.id }),
      ownerOxyUserId: options.ownerOxyUserId ?? OTHER_USER_ID,
      title: options.title ?? `List ${randomUUID()}`,
      description: options.description ?? null,
      isPublic: options.isPublic ?? true,
      ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
    })
    .returning({ id: accountLists.id });
  createdListIds.push(list.id);
  const members = options.members ?? [];
  if (members.length > 0) {
    await db.insert(accountListMembers).values(
      members.map((oxyUserId, position) => ({ listId: list.id, oxyUserId, position })),
    );
  }
  return list.id;
}

async function readMemberRows(listId: string): Promise<Array<{ oxyUserId: string; position: number }>> {
  return db
    .select({ oxyUserId: accountListMembers.oxyUserId, position: accountListMembers.position })
    .from(accountListMembers)
    .where(eq(accountListMembers.listId, listId))
    .orderBy(asc(accountListMembers.position));
}

function titles(body: { items: Array<{ title: string }> }): string[] {
  return body.items.map((item) => item.title);
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  authUserId = VIEWER_ID;
  mocks.transformPostsWithProfiles.mockReset().mockImplementation(
    async (records: Array<{ id: string; createdAt: Date; updatedAt: Date }>) =>
      records.map((record) => ({
        id: record.id,
        metadata: { createdAt: record.createdAt, updatedAt: record.updatedAt },
      })),
  );
});

afterEach(async () => {
  await clearPostScope(scope);
  if (createdListIds.length > 0) {
    await db.delete(accountLists).where(inArray(accountLists.id, createdListIds));
    createdListIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('membership order survives the junction', () => {
  it('stores the order the client sent, with contiguous positions', async () => {
    const res = await createList({ memberOxyUserIds: ['charlie', 'alpha', 'bravo'] });

    expect(res.status).toBe(201);
    expect(res.body.memberOxyUserIds).toEqual(['charlie', 'alpha', 'bravo']);
    expect(await readMemberRows(res.body.id)).toEqual([
      { oxyUserId: 'charlie', position: 0 },
      { oxyUserId: 'alpha', position: 1 },
      { oxyUserId: 'bravo', position: 2 },
    ]);
  });

  it('REORDERS an existing membership without colliding on (list_id, position)', async () => {
    /**
     * `(list_id, position)` is UNIQUE and Postgres checks a unique constraint per
     * STATEMENT, so shifting positions in place — even in one multi-row `UPDATE` —
     * fails against the rows that still hold them. The route deletes then
     * re-inserts, in that order, inside one transaction.
     */
    const created = await createList({ memberOxyUserIds: ['a', 'b', 'c'] });

    const res = await request(app)
      .put(`/lists/${created.body.id}`)
      .send({ memberOxyUserIds: ['c', 'b', 'a'] })
      .expect(200);

    expect(res.body.memberOxyUserIds).toEqual(['c', 'b', 'a']);
    expect(await readMemberRows(created.body.id)).toEqual([
      { oxyUserId: 'c', position: 0 },
      { oxyUserId: 'b', position: 1 },
      { oxyUserId: 'a', position: 2 },
    ]);
  });

  it('collapses a duplicate id the array used to keep twice', async () => {
    const res = await createList({ memberOxyUserIds: ['a', 'b', 'a'] });

    expect(res.body.memberOxyUserIds).toEqual(['a', 'b']);
  });

  it('appends new members and leaves the existing order alone', async () => {
    const created = await createList({ memberOxyUserIds: ['a', 'b'] });

    const res = await request(app)
      .post(`/lists/${created.body.id}/members`)
      .send({ userIds: ['c', 'a'] })
      .expect(200);

    expect(res.body.memberOxyUserIds).toEqual(['a', 'b', 'c']);
  });

  it('removes members and re-closes the position gap they left', async () => {
    const created = await createList({ memberOxyUserIds: ['a', 'b', 'c'] });

    const res = await request(app)
      .delete(`/lists/${created.body.id}/members`)
      .send({ userIds: ['b'] })
      .expect(200);

    expect(res.body.memberOxyUserIds).toEqual(['a', 'c']);
    expect(await readMemberRows(created.body.id)).toEqual([
      { oxyUserId: 'a', position: 0 },
      { oxyUserId: 'c', position: 1 },
    ]);
  });

  it('leaves membership untouched when a PUT does not mention it', async () => {
    const created = await createList({ memberOxyUserIds: ['a', 'b'] });

    const res = await request(app).put(`/lists/${created.body.id}`).send({ title: 'renamed' }).expect(200);

    expect(res.body.title).toBe('renamed');
    expect(res.body.memberOxyUserIds).toEqual(['a', 'b']);
  });

  it('deletes a list along with its members', async () => {
    const created = await createList({ memberOxyUserIds: ['a', 'b'] });

    await request(app).delete(`/lists/${created.body.id}`).expect(200);

    expect(await readMemberRows(created.body.id)).toEqual([]);
  });
});

describe('ownership and visibility', () => {
  it('refuses a stranger the detail of a PRIVATE list', async () => {
    const listId = await seedList({ isPublic: false, members: ['secret-member'] });

    const res = await request(app).get(`/lists/${listId}`);

    expect(res.status).toBe(403);
    expect(res.body).not.toHaveProperty('memberOxyUserIds');
  });

  it('serves a PUBLIC list to anyone', async () => {
    const listId = await seedList({ isPublic: true, members: ['member-a'] });

    const res = await request(app).get(`/lists/${listId}`).expect(200);

    expect(res.body.memberOxyUserIds).toEqual(['member-a']);
  });

  it('refuses a non-owner every write route', async () => {
    const listId = await seedList({ isPublic: true, members: ['a'] });

    for (const res of [
      await request(app).put(`/lists/${listId}`).send({ title: 'hacked' }),
      await request(app).post(`/lists/${listId}/members`).send({ userIds: ['b'] }),
      await request(app).delete(`/lists/${listId}/members`).send({ userIds: ['a'] }),
      await request(app).delete(`/lists/${listId}`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Not allowed');
    }

    const [row] = await db.select().from(accountLists).where(eq(accountLists.id, listId));
    expect(row.title).not.toBe('hacked');
    expect(await readMemberRows(listId)).toHaveLength(1);
  });

  it('404s a list id that names nothing, whatever its shape', async () => {
    // No id-shape guard survives: a `text` primary key that matches no row
    // already answers "no such list".
    for (const id of [uuidv7(), 'not-an-id-at-all']) {
      await request(app).get(`/lists/${id}`).expect(404);
    }
  });
});

describe('GET /lists — the visibility gate is unconditional', () => {
  it('shows the viewer their own private list plus every public one', async () => {
    await seedList({ title: `Mine ${run}`, isPublic: false, ownerOxyUserId: VIEWER_ID });
    await seedList({ title: `Public ${run}`, isPublic: true });
    await seedList({ title: `Private ${run}`, isPublic: false });

    const res = await request(app).get('/lists').expect(200);

    const visible = titles(res.body).filter((title) => title.includes(run));
    expect(visible.sort()).toEqual([`Mine ${run}`, `Public ${run}`]);
  });

  it("does NOT leak private lists to ?mine=false", async () => {
    /**
     * THE regression test. The gate used to be `if (!mine && !publicOnly)`, so
     * any truthy-but-not-`'true'` value — `?mine=false`, or `?mine[]=true`, which
     * arrives as an ARRAY — skipped it entirely and returned an unfiltered query:
     * every private list in the database, to any authenticated caller.
     */
    await seedList({ title: `Private ${run}`, isPublic: false });

    for (const query of [{ mine: 'false' }, { publicOnly: 'false' }, { 'mine[]': 'true' }]) {
      const res = await request(app).get('/lists').query(query).expect(200);
      expect(titles(res.body)).not.toContain(`Private ${run}`);
    }
  });

  it('narrows to the viewer with ?mine=true', async () => {
    await seedList({ title: `Mine ${run}`, isPublic: true, ownerOxyUserId: VIEWER_ID });
    await seedList({ title: `Theirs ${run}`, isPublic: true });

    const res = await request(app).get('/lists').query({ mine: 'true' }).expect(200);

    expect(titles(res.body).filter((title) => title.includes(run))).toEqual([`Mine ${run}`]);
  });

  it('narrows to public lists with ?publicOnly=true, including the viewer own', async () => {
    await seedList({ title: `MinePrivate ${run}`, isPublic: false, ownerOxyUserId: VIEWER_ID });
    await seedList({ title: `Public ${run}`, isPublic: true });

    const res = await request(app).get('/lists').query({ publicOnly: 'true' }).expect(200);

    expect(titles(res.body).filter((title) => title.includes(run))).toEqual([`Public ${run}`]);
  });

  it('requires authentication', async () => {
    authUserId = undefined;

    await request(app).get('/lists').expect(401);
  });

  it('narrows by search without letting a LIKE wildcard match everything', async () => {
    await seedList({ title: `Photographers ${run}`, isPublic: true });
    await seedList({ title: `Cyclists ${run}`, isPublic: true });

    const wildcard = await request(app).get('/lists').query({ search: '%' }).expect(200);
    expect(titles(wildcard.body)).not.toContain(`Photographers ${run}`);

    const literal = await request(app).get('/lists').query({ search: `Photographers ${run}` }).expect(200);
    expect(titles(literal.body)).toEqual([`Photographers ${run}`]);
  });

  it('never widens the visibility gate through the search term', async () => {
    await seedList({ title: `Secret ${run}`, isPublic: false });

    const res = await request(app).get('/lists').query({ search: `Secret ${run}` }).expect(200);

    expect(res.body.items).toEqual([]);
  });

  it('matches case-insensitively, on the description as well as the title', async () => {
    await seedList({ title: `Sports fans ${run}`, description: `athletes ${run}`, isPublic: true });
    await seedList({ title: `Cooking ${run}`, description: 'recipes', isPublic: true });

    const res = await request(app).get('/lists').query({ search: `ATHLETES ${run}` }).expect(200);

    expect(titles(res.body)).toEqual([`Sports fans ${run}`]);
  });
});

describe('GET /lists — pagination on a total order', () => {
  const TIED = new Date(Date.UTC(2026, 6, 7, 8, 9, 10));
  /** Inserted in ASCENDING id order, so physical order is the reverse of correct. */
  const TIED_IDS = ['a', 'b', 'c', 'd'].map(
    (suffix) => `0198a2b1-4c3d-7e2f-8a1b-00000000000${suffix}`,
  );

  async function seedTied(): Promise<void> {
    for (const [index, id] of TIED_IDS.entries()) {
      await seedList({
        id,
        title: `Tied ${index} ${run}`,
        isPublic: true,
        ownerOxyUserId: VIEWER_ID,
        updatedAt: TIED,
      });
    }
  }

  it('breaks an updatedAt tie by id, descending', async () => {
    await seedTied();

    const res = await request(app).get('/lists').query({ mine: 'true' }).expect(200);

    expect(titles(res.body)).toEqual([
      `Tied 3 ${run}`, `Tied 2 ${run}`, `Tied 1 ${run}`, `Tied 0 ${run}`,
    ]);
  });

  it('walks a tied set one row per page without repeating or skipping one', async () => {
    await seedTied();

    const seen: string[] = [];
    for (let offset = 0; offset < TIED_IDS.length; offset += 1) {
      const res = await request(app)
        .get('/lists')
        .query({ mine: 'true', limit: 1, offset })
        .expect(200);
      seen.push(...titles(res.body));
    }

    expect(seen).toEqual([
      `Tied 3 ${run}`, `Tied 2 ${run}`, `Tied 1 ${run}`, `Tied 0 ${run}`,
    ]);
  });

  it('reports the real match count and hasMore, not the page length', async () => {
    await seedTied();

    const res = await request(app).get('/lists').query({ mine: 'true', limit: 2 }).expect(200);

    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(4);
    // A bigint `count(*)` comes back from the driver as a STRING; `total` must
    // stay the number the client has always parsed.
    expect(typeof res.body.total).toBe('number');
    expect(res.body.pagination).toEqual({ offset: 0, limit: 2, hasMore: true });
  });

  it('returns every accessible list, unpaginated, when no limit is given', async () => {
    await seedTied();

    const res = await request(app).get('/lists').query({ mine: 'true' }).expect(200);

    expect(res.body.items).toHaveLength(4);
    expect(res.body.total).toBe(4);
    expect(res.body.pagination).toEqual({ offset: 0, limit: 4, hasMore: false });
  });

  it('drives the whole set from hasMore, with every non-terminal page full', async () => {
    // Five distinct `updatedAt` values, so this walk is about the pagination
    // contract itself rather than the tiebreak the cases above pin.
    for (let index = 0; index < 5; index += 1) {
      await seedList({
        title: `Team ${index} ${run}`,
        isPublic: true,
        ownerOxyUserId: VIEWER_ID,
        updatedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, 100 - index)),
      });
    }

    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 10; guard += 1) {
      const res = await request(app)
        .get('/lists')
        .query({ mine: 'true', limit: 2, offset })
        .expect(200);
      const page = titles(res.body);
      seen.push(...page);
      expect(res.body.total).toBe(5);
      if (!res.body.pagination.hasMore) break;
      expect(page).toHaveLength(2);
      offset = res.body.pagination.offset + res.body.pagination.limit;
    }

    expect(seen).toEqual([
      `Team 0 ${run}`, `Team 1 ${run}`, `Team 2 ${run}`, `Team 3 ${run}`, `Team 4 ${run}`,
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe('wire format parity', () => {
  it('emits _id alongside id, with the defaults a Mongoose document carried', async () => {
    const res = await createList({});

    expect(res.body._id).toBe(res.body.id);
    expect(res.body.isPublic).toBe(true);
    expect(res.body.subscriberCount).toBe(0);
    expect(res.body.memberOxyUserIds).toEqual([]);
    expect(res.body.ownerOxyUserId).toBe(VIEWER_ID);
  });

  it('OMITS an absent description rather than sending null', async () => {
    const res = await createList({});

    expect('description' in res.body).toBe(false);
    expect(JSON.parse(JSON.stringify(res.body))).not.toHaveProperty('description');
  });

  it('rejects a create with no title', async () => {
    const res = await request(app).post('/lists').send({ description: 'no title here' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Title is required');
  });
});

describe('GET /lists/:id/timeline', () => {
  const MEMBER_A = `${VIEWER_ID}-member-a`;
  const MEMBER_B = `${VIEWER_ID}-member-b`;
  const OUTSIDER = `${VIEWER_ID}-outsider`;

  async function seedMemberPost(author: string, overrides: Parameters<typeof seedPost>[1] = {}) {
    return seedPost(scope, {
      oxyUserId: author,
      authorship: [{ oxyUserId: author, role: 'owner', status: 'accepted' }],
      ...overrides,
    });
  }

  interface TimelineBody {
    items: Array<{ id: string }>;
    hasMore: boolean;
    nextCursor?: string;
    totalCount: number;
  }

  async function timeline(
    listId: string,
    query: Record<string, string | number> = {},
  ): Promise<TimelineBody> {
    const res = await request(app).get(`/lists/${listId}/timeline`).query(query).expect(200);
    return res.body as TimelineBody;
  }

  it('404s a list that does not exist', async () => {
    await request(app).get(`/lists/${uuidv7()}/timeline`).expect(404);
    expect(mocks.transformPostsWithProfiles).not.toHaveBeenCalled();
  });

  it('403s a stranger on a private list, before reading any post', async () => {
    const listId = await seedList({ isPublic: false, members: [MEMBER_A] });
    await seedMemberPost(MEMBER_A);

    await request(app).get(`/lists/${listId}/timeline`).expect(403);

    expect(mocks.transformPostsWithProfiles).not.toHaveBeenCalled();
  });

  it('serves the members’ public posts and nobody else’s', async () => {
    const listId = await seedList({ isPublic: true, members: [MEMBER_A, MEMBER_B] });
    const fromA = await seedMemberPost(MEMBER_A);
    const fromB = await seedMemberPost(MEMBER_B);
    await seedMemberPost(OUTSIDER);
    // A member's non-public post is still the member's, and still excluded.
    await seedMemberPost(MEMBER_A, { visibility: 'followers_only' });

    const body = await timeline(listId, { limit: 50 });

    expect(body.items.map((item) => item.id).sort()).toEqual([fromA.id, fromB.id].sort());
    expect(body.totalCount).toBe(2);
  });

  it('returns an empty page for a list with no members, without querying posts', async () => {
    const listId = await seedList({ isPublic: true, members: [] });
    await seedMemberPost(OUTSIDER);

    expect(await timeline(listId)).toEqual({ items: [], hasMore: false, totalCount: 0 });
  });

  it('pages chronologically and never repeats or skips a post', async () => {
    // Two pre-cutover ObjectId ids and two uuid v7 ids, all sharing one
    // `createdAt`, so the page boundary rests entirely on the id tie-break. Ids
    // of ONE shape cannot reproduce the interleaving: under text collation every
    // uuid ('0…') sorts below every ObjectId ('6…').
    const listId = await seedList({ isPublic: true, members: [MEMBER_A] });
    const SAME = new Date('2026-04-01T00:00:00.000Z');
    const ids = [
      '65fdc8c8c8c8c8c8c8c8c8d8',
      '65fdc8c8c8c8c8c8c8c8c8d9',
      '019616a0-0000-7000-8000-00000000001a',
      '019616a0-0000-7000-8000-00000000001b',
    ];
    for (const id of ids) {
      await seedMemberPost(MEMBER_A, { id, createdAt: SAME });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const body: TimelineBody = await timeline(listId, {
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...body.items.map((item) => item.id));
      if (!body.hasMore) break;
      expect(body.nextCursor).toBeTruthy();
      cursor = body.nextCursor;
    }

    expect(new Set(seen).size).toBe(ids.length);
    expect(seen.sort()).toEqual([...ids].sort());
  });
});
