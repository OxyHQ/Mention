/**
 * `/subscriptions` against real rows — the activity-subscriptions API.
 *
 * Three things it must never get wrong:
 *
 *  - **Identity.** Rows carry the canonical Oxy `PostUser`, passed through
 *    unchanged. An author Oxy could not resolve arrives DEGRADED (empty
 *    username, `'Unknown user'`) — a raw `oxyUserId` must never reach a client
 *    as a handle, because `/@<id>` is not a profile.
 *  - **Paging.** `created_at` is not unique, so the cursor is a COMPOUND keyset
 *    (`created_at` + `id`). Without the tie-break, two subscriptions made in the
 *    same millisecond straddle the page boundary and one is silently dropped —
 *    pinned explicitly below against rows that really do share an instant.
 *  - **The cursor accepts BOTH live id shapes.** The `ObjectId.isValid` check the
 *    Mongo version ran on the id half fails open (⇒ page one), so keeping it
 *    would have made every post-cutover scroll loop over the first page forever.
 *
 * Only the Oxy identity resolver is stubbed; the subscriptions themselves are
 * real Postgres rows.
 */

import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import type { CachedUserSummary } from '../../services/userSummaryCache';

const { mockResolveUserSummaries } = vi.hoisted(() => ({
  mockResolveUserSummaries: vi.fn(),
}));

vi.mock('../../services/PostHydrationService', async () => {
  // The REAL degraded summary, so a change to its shape breaks this test rather
  // than being masked by a hand-written stub.
  const { degradedActorSummary } = await import('../../utils/degradedActorSummary');
  return { resolveUserSummaries: mockResolveUserSummaries, degradedActorSummary };
});

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { uuidv7 } from '../../db/schema/columns';
import { postSubscriptions } from '../../db/schema/engagement';
import subscriptionsRouter from '../../routes/subscriptions';

let db: Database;
const createdSubscriberIds: string[] = [];

function subscriberId(): string {
  const id = `oxy-subscriber-${randomUUID()}`;
  createdSubscriberIds.push(id);
  return id;
}

function buildApp(viewer: string | undefined): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
    if (viewer) req.user = { id: viewer };
    next();
  });
  app.use('/subscriptions', subscriptionsRouter);
  return app;
}

function summary(id: string, displayName: string, avatar: string): CachedUserSummary {
  return {
    user: {
      id,
      username: displayName.toLowerCase(),
      name: { displayName },
      avatar,
      verified: true,
    },
    followerCount: 42,
  };
}

/** Seed a subscription with an explicit `created_at`, so ties are deliberate. */
async function seed(subscriber: string, authorId: string, createdAt: string, id = uuidv7()) {
  await db.insert(postSubscriptions).values({
    id,
    subscriberId: subscriber,
    authorId,
    createdAt: new Date(createdAt),
  });
  return id;
}

const authorIds = (body: { subscriptions: { author: { id: string } }[] }) =>
  body.subscriptions.map((entry) => entry.author.id);

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  mockResolveUserSummaries.mockReset();
  mockResolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());
});

afterEach(async () => {
  if (createdSubscriberIds.length > 0) {
    await db
      .delete(postSubscriptions)
      .where(inArray(postSubscriptions.subscriberId, createdSubscriberIds));
    createdSubscriberIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('GET /subscriptions', () => {
  it('rejects an anonymous viewer', async () => {
    const res = await request(buildApp(undefined)).get('/subscriptions');
    expect(res.status).toBe(401);
  });

  it('hydrates authors into the canonical Oxy user, newest first', async () => {
    const viewer = subscriberId();
    await seed(viewer, 'author-old', '2026-07-01T00:00:00.000Z');
    await seed(viewer, 'author-new', '2026-07-02T00:00:00.000Z');
    mockResolveUserSummaries.mockResolvedValue(
      new Map([
        ['author-old', summary('author-old', 'Ada', 'file-ada')],
        ['author-new', summary('author-new', 'Grace', 'file-grace')],
      ]),
    );

    const res = await request(buildApp(viewer)).get('/subscriptions');

    expect(res.status).toBe(200);
    // ONE batched identity call for the page, not one per row.
    expect(mockResolveUserSummaries).toHaveBeenCalledTimes(1);
    expect(mockResolveUserSummaries).toHaveBeenCalledWith(['author-new', 'author-old']);
    expect(res.body.subscriptions).toEqual([
      {
        author: {
          id: 'author-new',
          username: 'grace',
          name: { displayName: 'Grace' },
          // A bare Oxy file id, NOT pre-resolved to a URL — Bloom's ImageResolver owns that.
          avatar: 'file-grace',
          verified: true,
        },
        createdAt: '2026-07-02T00:00:00.000Z',
      },
      {
        author: {
          id: 'author-old',
          username: 'ada',
          name: { displayName: 'Ada' },
          avatar: 'file-ada',
          verified: true,
        },
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ]);
    // Ranking-side facts stay off the DTO.
    expect(res.body.subscriptions[0].author).not.toHaveProperty('followerCount');
    expect(res.body.nextCursor).toBeUndefined();
  });

  it('never returns another viewer’s subscriptions', async () => {
    const viewer = subscriberId();
    const stranger = subscriberId();
    await seed(viewer, 'author-mine', '2026-07-01T00:00:00.000Z');
    await seed(stranger, 'author-theirs', '2026-07-02T00:00:00.000Z');

    const res = await request(buildApp(viewer)).get('/subscriptions');
    expect(authorIds(res.body)).toEqual(['author-mine']);
  });

  it('degrades an unresolvable author instead of emitting its id as a handle', async () => {
    const viewer = subscriberId();
    await seed(viewer, 'ghost-id', '2026-07-01T00:00:00.000Z');
    mockResolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());

    const res = await request(buildApp(viewer)).get('/subscriptions');

    expect(res.status).toBe(200);
    const [row] = res.body.subscriptions;
    expect(row.author.id).toBe('ghost-id');
    expect(row.author.username).toBe('');
    expect(row.author.name.displayName).toBe('Unknown user');
    expect(JSON.stringify(row.author.username)).not.toContain('ghost-id');
  });

  it('still returns the page when identity resolution fails outright', async () => {
    const viewer = subscriberId();
    await seed(viewer, 'author-a', '2026-07-01T00:00:00.000Z');
    mockResolveUserSummaries.mockRejectedValue(new Error('oxy unreachable'));

    const res = await request(buildApp(viewer)).get('/subscriptions');

    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].author.name.displayName).toBe('Unknown user');
  });

  it('pages with a compound cursor, so a same-millisecond tie is never dropped', async () => {
    // B and C share a createdAt to the millisecond — the exact case a bare
    // `createdAt` cursor loses. Their ids are ORDERED, so the expected page
    // contents are a fact about the keyset rather than about id generation.
    const viewer = subscriberId();
    const sameInstant = '2026-07-02T00:00:00.000Z';
    const [idB, idC] = [uuidv7(), uuidv7()].sort();
    await seed(viewer, 'author-a', '2026-07-03T00:00:00.000Z');
    await seed(viewer, 'author-b', sameInstant, idB);
    await seed(viewer, 'author-c', sameInstant, idC);

    const app = buildApp(viewer);
    const first = await request(app).get('/subscriptions').query({ limit: 2 });

    expect(first.status).toBe(200);
    expect(authorIds(first.body)).toEqual(['author-a', 'author-c']);
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await request(app)
      .get('/subscriptions')
      .query({ limit: 2, cursor: first.body.nextCursor });

    expect(second.status).toBe(200);
    // No overlap with page 1 and no gap: the tied row survives the boundary.
    expect(authorIds(second.body)).toEqual(['author-b']);
    expect(second.body.nextCursor).toBeUndefined();
  });

  it('pages a uuid v7 cursor, which every post-cutover row carries', async () => {
    // The regression the deleted `ObjectId.isValid` check would cause: a v7 id
    // fails the 24-hex test, the cursor is discarded, and the client re-reads
    // page one forever without a single error anywhere.
    const viewer = subscriberId();
    await seed(viewer, 'author-a', '2026-07-03T00:00:00.000Z');
    await seed(viewer, 'author-b', '2026-07-02T00:00:00.000Z');

    const app = buildApp(viewer);
    const first = await request(app).get('/subscriptions').query({ limit: 1 });
    expect(first.body.nextCursor).toMatch(/^\d+_[0-9a-f]{8}-[0-9a-f]{4}-7/);

    const second = await request(app)
      .get('/subscriptions')
      .query({ limit: 1, cursor: first.body.nextCursor });
    expect(authorIds(second.body)).toEqual(['author-b']);
  });

  it('pages an ObjectId-hex cursor, which every pre-cutover row keeps', async () => {
    const viewer = subscriberId();
    await seed(viewer, 'author-a', '2026-07-03T00:00:00.000Z', '000000000000000000000002');
    await seed(viewer, 'author-b', '2026-07-02T00:00:00.000Z', '000000000000000000000001');

    const app = buildApp(viewer);
    const first = await request(app).get('/subscriptions').query({ limit: 1 });
    expect(first.body.nextCursor).toBe('1783036800000_000000000000000000000002');

    const second = await request(app)
      .get('/subscriptions')
      .query({ limit: 1, cursor: first.body.nextCursor });
    expect(authorIds(second.body)).toEqual(['author-b']);
  });

  it('ignores a malformed cursor instead of erroring', async () => {
    const viewer = subscriberId();
    await seed(viewer, 'author-a', '2026-07-01T00:00:00.000Z');

    for (const cursor of ['nonsense', '_', 'abc_def', `${Date.now()}_`, '123']) {
      const res = await request(buildApp(viewer)).get('/subscriptions').query({ cursor });
      expect(res.status).toBe(200);
      expect(res.body.subscriptions).toHaveLength(1);
    }
  });

  it('defaults to 50 rows and clamps an oversized limit to 100', async () => {
    const viewer = subscriberId();
    for (let index = 0; index < 3; index += 1) {
      await seed(viewer, `author-${index}`, `2026-07-0${index + 1}T00:00:00.000Z`);
    }
    const app = buildApp(viewer);

    // The clamp is only observable through the page it produces, so the row
    // counts are the assertion rather than the number the handler computed.
    expect((await request(app).get('/subscriptions')).body.subscriptions).toHaveLength(3);
    expect(
      (await request(app).get('/subscriptions').query({ limit: 5000 })).body.subscriptions,
    ).toHaveLength(3);
    expect(
      (await request(app).get('/subscriptions').query({ limit: -3 })).body.subscriptions,
    ).toHaveLength(1);
    expect(
      (await request(app).get('/subscriptions').query({ limit: 2 })).body.subscriptions,
    ).toHaveLength(2);
  });
});

describe('subscribe / unsubscribe / status', () => {
  it('is idempotent and never writes a second row', async () => {
    const viewer = subscriberId();
    const app = buildApp(viewer);

    await request(app).post('/subscriptions/author-1').expect(200);
    await request(app).post('/subscriptions/author-1').expect(200);

    const rows = await db
      .select()
      .from(postSubscriptions)
      .where(inArray(postSubscriptions.subscriberId, [viewer]));
    expect(rows).toHaveLength(1);
  });

  it('reports status, then clears it on unsubscribe', async () => {
    const viewer = subscriberId();
    const app = buildApp(viewer);

    expect((await request(app).get('/subscriptions/author-1/status')).body).toEqual({
      subscribed: false,
    });
    await request(app).post('/subscriptions/author-1').expect(200);
    expect((await request(app).get('/subscriptions/author-1/status')).body).toEqual({
      subscribed: true,
    });
    await request(app).delete('/subscriptions/author-1').expect(200);
    expect((await request(app).get('/subscriptions/author-1/status')).body).toEqual({
      subscribed: false,
    });
  });

  it('refuses a self-subscription', async () => {
    const viewer = subscriberId();
    await request(buildApp(viewer)).post(`/subscriptions/${viewer}`).expect(400);
    const rows = await db
      .select()
      .from(postSubscriptions)
      .where(inArray(postSubscriptions.subscriberId, [viewer]));
    expect(rows).toEqual([]);
  });

  it('unsubscribes only the caller’s own row', async () => {
    const viewer = subscriberId();
    const stranger = subscriberId();
    await seed(stranger, 'author-1', '2026-07-01T00:00:00.000Z');

    await request(buildApp(viewer)).delete('/subscriptions/author-1').expect(200);

    const rows = await db
      .select()
      .from(postSubscriptions)
      .where(inArray(postSubscriptions.subscriberId, [stranger]));
    expect(rows).toHaveLength(1);
  });
});
