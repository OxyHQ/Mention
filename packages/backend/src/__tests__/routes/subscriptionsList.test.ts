import express, { type NextFunction, type Response } from 'express';
import request from 'supertest';
import { Types } from 'mongoose';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { OxyAuthRequest } from '@oxyhq/core/server';
import type { CachedUserSummary } from '../../services/userSummaryCache';

/**
 * `GET /subscriptions` — the list endpoint behind the activity-subscriptions
 * screen. Two things it must never get wrong:
 *
 *  - **Identity.** Rows carry the canonical Oxy `PostUser`, passed through
 *    unchanged. An author Oxy could not resolve arrives DEGRADED (empty
 *    username, `'Unknown user'`) — a raw `oxyUserId` must never reach a client
 *    as a handle, because `/@<id>` is not a profile.
 *  - **Paging.** `createdAt` is not unique, so the cursor is a COMPOUND keyset
 *    (`createdAt` + `_id`). Without the tie-break, two subscriptions made in the
 *    same millisecond straddle the page boundary and one of them is silently
 *    dropped — the case this suite pins explicitly.
 */

const { mockResolveUserSummaries, mockFind } = vi.hoisted(() => ({
  mockResolveUserSummaries: vi.fn(),
  mockFind: vi.fn(),
}));

vi.mock('../../services/PostHydrationService', async () => {
  // The REAL degraded summary, so a change to its shape breaks this test rather
  // than being masked by a hand-written stub.
  const { degradedActorSummary } = await import('../../utils/degradedActorSummary.js');
  return { resolveUserSummaries: mockResolveUserSummaries, degradedActorSummary };
});

vi.mock('../../models/PostSubscription', () => {
  const model = { find: (...args: unknown[]) => mockFind(...args) };
  return { default: model, PostSubscription: model };
});

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import subscriptionsRouter from '../../routes/subscriptions';

const VIEWER_ID = 'viewer-1';

interface SubscriptionDoc {
  _id: Types.ObjectId;
  subscriberId: string;
  authorId: string;
  createdAt: Date;
}

function buildApp(authenticated = true): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: OxyAuthRequest, _res: Response, next: NextFunction) => {
    if (authenticated) req.user = { id: VIEWER_ID };
    next();
  });
  app.use('/subscriptions', subscriptionsRouter);
  return app;
}

/** Values the handler compares on: `Date` by time, `ObjectId` by hex. */
function order(value: unknown): number | string {
  if (value instanceof Date) return value.getTime();
  return String(value);
}

function compare(a: unknown, b: unknown): number {
  const [x, y] = [order(a), order(b)];
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/** Just the operators this handler builds: equality, `$or`, and `$lt`. */
function matches(doc: SubscriptionDoc, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$or') {
      return (
        Array.isArray(condition) &&
        condition.some((sub) => matches(doc, sub as Record<string, unknown>))
      );
    }
    const value = doc[key as keyof SubscriptionDoc];
    if (condition && typeof condition === 'object' && '$lt' in condition) {
      return compare(value, (condition as { $lt: unknown }).$lt) < 0;
    }
    return compare(value, condition) === 0;
  });
}

/** Records the limit the handler asked for so the overfetch can be asserted. */
let requestedLimit: number | undefined;

function seedSubscriptions(docs: SubscriptionDoc[]): void {
  requestedLimit = undefined;
  mockFind.mockImplementation((query: Record<string, unknown>) => {
    const filtered = docs.filter((doc) => matches(doc, query));
    let sortSpec: Record<string, 1 | -1> = {};
    let limitN: number | undefined;
    const builder = {
      sort(spec: Record<string, 1 | -1>) {
        sortSpec = spec;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        requestedLimit = n;
        return builder;
      },
      lean() {
        const sorted = [...filtered].sort((a, b) => {
          for (const [key, direction] of Object.entries(sortSpec)) {
            const result = compare(a[key as keyof SubscriptionDoc], b[key as keyof SubscriptionDoc]);
            if (result !== 0) return result * direction;
          }
          return 0;
        });
        return Promise.resolve(limitN === undefined ? sorted : sorted.slice(0, limitN));
      },
    };
    return builder;
  });
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

function doc(authorId: string, createdAt: string, id: string): SubscriptionDoc {
  return {
    _id: new Types.ObjectId(id),
    subscriberId: VIEWER_ID,
    authorId,
    createdAt: new Date(createdAt),
  };
}

const ID_A = '000000000000000000000001';
const ID_B = '000000000000000000000002';
const ID_C = '000000000000000000000003';

describe('GET /subscriptions', () => {
  beforeEach(() => {
    mockResolveUserSummaries.mockReset();
    mockFind.mockReset();
    mockResolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());
  });

  it('rejects an anonymous viewer', async () => {
    seedSubscriptions([]);
    const res = await request(buildApp(false)).get('/subscriptions');
    expect(res.status).toBe(401);
  });

  it('hydrates authors into the canonical Oxy user, newest first', async () => {
    seedSubscriptions([
      doc('author-old', '2026-07-01T00:00:00.000Z', ID_A),
      doc('author-new', '2026-07-02T00:00:00.000Z', ID_B),
    ]);
    mockResolveUserSummaries.mockResolvedValue(
      new Map([
        ['author-old', summary('author-old', 'Ada', 'file-ada')],
        ['author-new', summary('author-new', 'Grace', 'file-grace')],
      ]),
    );

    const res = await request(buildApp()).get('/subscriptions');

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

  it('degrades an unresolvable author instead of emitting its id as a handle', async () => {
    seedSubscriptions([doc('ghost-id', '2026-07-01T00:00:00.000Z', ID_A)]);
    mockResolveUserSummaries.mockResolvedValue(new Map<string, CachedUserSummary>());

    const res = await request(buildApp()).get('/subscriptions');

    expect(res.status).toBe(200);
    const [row] = res.body.subscriptions;
    expect(row.author.id).toBe('ghost-id');
    expect(row.author.username).toBe('');
    expect(row.author.name.displayName).toBe('Unknown user');
    expect(JSON.stringify(row.author.username)).not.toContain('ghost-id');
  });

  it('still returns the page when identity resolution fails outright', async () => {
    seedSubscriptions([doc('author-a', '2026-07-01T00:00:00.000Z', ID_A)]);
    mockResolveUserSummaries.mockRejectedValue(new Error('oxy unreachable'));

    const res = await request(buildApp()).get('/subscriptions');

    expect(res.status).toBe(200);
    expect(res.body.subscriptions).toHaveLength(1);
    expect(res.body.subscriptions[0].author.name.displayName).toBe('Unknown user');
  });

  it('pages with a compound cursor, so a same-millisecond tie is never dropped', async () => {
    // B and C share a createdAt to the millisecond — the exact case a bare
    // `createdAt` cursor loses.
    const sameInstant = '2026-07-02T00:00:00.000Z';
    seedSubscriptions([
      doc('author-a', '2026-07-03T00:00:00.000Z', ID_A),
      doc('author-b', sameInstant, ID_B),
      doc('author-c', sameInstant, ID_C),
    ]);

    const app = buildApp();
    const first = await request(app).get('/subscriptions').query({ limit: 2 });

    expect(first.status).toBe(200);
    // limit + 1: the extra row is what proves there IS a next page.
    expect(requestedLimit).toBe(3);
    expect(first.body.subscriptions.map((s: { author: { id: string } }) => s.author.id)).toEqual([
      'author-a',
      'author-c',
    ]);
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await request(app)
      .get('/subscriptions')
      .query({ limit: 2, cursor: first.body.nextCursor });

    expect(second.status).toBe(200);
    // No overlap with page 1 and no gap: the tied row survives the boundary.
    expect(second.body.subscriptions.map((s: { author: { id: string } }) => s.author.id)).toEqual([
      'author-b',
    ]);
    expect(second.body.nextCursor).toBeUndefined();
  });

  it('ignores a malformed cursor instead of erroring', async () => {
    seedSubscriptions([doc('author-a', '2026-07-01T00:00:00.000Z', ID_A)]);

    for (const cursor of ['nonsense', '_', 'abc_def', `${Date.now()}_not-an-object-id`, '123']) {
      const res = await request(buildApp()).get('/subscriptions').query({ cursor });
      expect(res.status).toBe(200);
      expect(res.body.subscriptions).toHaveLength(1);
    }
  });

  it('defaults to 50 rows and clamps an oversized limit to 100', async () => {
    seedSubscriptions([]);
    const app = buildApp();

    await request(app).get('/subscriptions');
    expect(requestedLimit).toBe(51);

    await request(app).get('/subscriptions').query({ limit: 5000 });
    expect(requestedLimit).toBe(101);

    await request(app).get('/subscriptions').query({ limit: -3 });
    expect(requestedLimit).toBe(2);
  });
});
