import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rate limiting on `GET /lanes/mine`.
 *
 * That route is the only one on the lanes router whose cost scales with the
 * CALLER'S OWN HISTORY and is not cached: `countPostsByLane` runs a `$group` that
 * walks one index entry per lane-bearing post the caller has ever written, with
 * no page and no cache. Every sibling is a point lookup or a bounded list, so
 * this is a bound on one aggregation rather than a limiter on a surface — and the
 * test asserts exactly that asymmetry, because a limiter accidentally applied to
 * the whole router would pass a test that only hammered `/mine`.
 *
 * TWO stand-ins are required, and WITHOUT EITHER THIS TEST CANNOT FAIL:
 *
 *  1. **The store.** `RedisStore` deliberately degrades OPEN when Redis is absent
 *     (`increment` falls back to `{ totalHits: 1 }`), so the real store never
 *     throttles under test. Swapped for the same in-memory stand-in
 *     `statisticsRateLimit.test.ts` uses.
 *  2. **`config.runtime.isProduction`.** The limiter is mounted
 *     `...(isProduction ? [limiter] : [])`, so outside production it is not in
 *     the chain at all and no amount of hammering produces a 429. Forced on here.
 *
 * A version of this test missing either one passes against a route with no
 * limiter whatsoever, which is why both are called out rather than left as setup.
 */

const { MemoryStore, LIMIT } = vi.hoisted(() => {
  /**
   * In-memory stand-in for `RedisStore`, same surface, no Redis.
   *
   * The counters live in a MODULE-LEVEL keyspace keyed by `<prefix><key>`, not on
   * the instance — because that is what Redis is. A per-instance Map would give
   * every limiter its own counter for free, so two limiters sharing a prefix
   * would still behave independently under test and the separation asserted below
   * would hold no matter what the source said. Modelling the shared keyspace is
   * what lets that assertion fail when the prefixes collide.
   */
  const keyspace = new Map<string, number>();

  class MemoryStore {
    readonly prefix: string;

    constructor(options: { prefix?: string } = {}) {
      this.prefix = options.prefix ?? 'rate-limit:';
    }

    private slot(key: string): string {
      return `${this.prefix}${key}`;
    }

    init(): void {
      // express-rate-limit hands the window in; this store never expires entries
      // because every test asserts within a single window.
    }

    async increment(key: string): Promise<{ totalHits: number; resetTime: Date | undefined }> {
      const next = (keyspace.get(this.slot(key)) ?? 0) + 1;
      keyspace.set(this.slot(key), next);
      return { totalHits: next, resetTime: undefined };
    }

    async decrement(key: string): Promise<void> {
      keyspace.set(this.slot(key), Math.max(0, (keyspace.get(this.slot(key)) ?? 0) - 1));
    }

    async resetKey(key: string): Promise<void> {
      keyspace.delete(this.slot(key));
    }
  }

  /** Copied from `middleware/security.ts`; a drift here is a real failure. */
  return { MemoryStore, LIMIT: 120 };
});

vi.mock('../../middleware/rateLimitStore', () => ({ RedisStore: MemoryStore }));

vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return {
    ...actual,
    config: { ...actual.config, runtime: { ...actual.config.runtime, isProduction: true } },
  };
});

/** The models the handler touches — stubbed so a request's only cost is the limiter. */
vi.mock('../../models/Lane', () => ({
  Lane: {
    find: () => ({ sort: () => ({ lean: async () => [] }) }),
    findById: () => ({ select: () => ({ lean: async () => null }) }),
    findOne: () => ({ select: () => ({ lean: async () => null }) }),
    countDocuments: async () => 0,
    create: async () => ({ toObject: () => ({}) }),
    deleteOne: async () => ({ deletedCount: 1 }),
  },
  normalizeLaneName: (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase(),
}));

vi.mock('../../models/LaneMute', () => ({
  LaneMute: {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
    findOne: () => ({ select: () => ({ lean: async () => null }) }),
    countDocuments: async () => 0,
    create: async () => ({}),
    deleteOne: async () => ({ deletedCount: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
  },
}));

vi.mock('../../models/Post', () => ({
  Post: { aggregate: async () => [], updateMany: async () => ({ modifiedCount: 0 }) },
}));

vi.mock('../../services/PostHydrationService', () => ({
  resolveUserSummaries: async () => new Map(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@oxyhq/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxyhq/core/server')>();
  return {
    ...actual,
    requireOxyAuth: (_req: unknown, _res: unknown, next: express.NextFunction) => next(),
    getRequiredOxyUserId: (req: express.Request & { user?: { id: string } }) => req.user?.id ?? '',
  };
});

import lanesRouter from '../../routes/lanes.routes';

/**
 * A UNIQUE identity per app. The limiter is a module-level singleton created at
 * import — one store shared by every test in this file — so a fixed id would let
 * one test's hammering spend the next test's budget, and the failure would read
 * as an over-tight limit rather than cross-test bleed.
 */
let identityCounter = 0;
function buildApp(userId = `viewer-${(identityCounter += 1)}`) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: string } }).user = { id: userId };
    next();
  });
  app.use('/lanes', lanesRouter);
  return app;
}

/** Issue `count` sequential GETs and return the last status seen. */
async function hammer(app: express.Express, path: string, count: number): Promise<number> {
  let status = 0;
  for (let i = 0; i < count; i += 1) {
    status = (await request(app).get(path)).status;
  }
  return status;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /lanes/mine rate limiting', () => {
  it('serves the whole budget, then answers 429', async () => {
    const app = buildApp();

    expect(await hammer(app, '/lanes/mine', LIMIT)).toBe(200);
    expect((await request(app).get('/lanes/mine')).status).toBe(429);
  });

  it('keys per CALLER — one caller\'s spend never throttles another', async () => {
    const noisy = buildApp();
    await hammer(noisy, '/lanes/mine', LIMIT + 1);

    // A fresh identity, same route, same module-level store.
    const quiet = buildApp();
    expect((await request(quiet).get('/lanes/mine')).status).toBe(200);
  });

  it('spends its OWN budget — exhausting /mine leaves a sibling route serving', async () => {
    // Siblings ARE limited now — the compliance limiters cover the whole router —
    // so the property is not "unlimited" but SEPARATE: `/mine` carries
    // `lanesRateLimiter` (`rate-limit:lanes:`, 120) while `/muted` carries
    // `laneReadRateLimiter` (`rate-limit:lanes-read:`, 300).
    //
    // What this DOES prove: exhausting `/mine` leaves `/muted` serving, so the
    // expensive route's budget is not the router's budget.
    //
    // What it does NOT prove, deliberately: that the two prefixes differ. The
    // stand-in store models Redis's shared keyspace, so a collision is
    // observable in principle — but only once one route's spend exceeds the
    // OTHER's ceiling, which here would mean hammering past 300 to catch
    // something `rateLimitPrefixUniqueness` already proves statically and
    // exhaustively across the whole tree. Prefix separation is that test's job;
    // this one owns budget separation.
    const app = buildApp();
    await hammer(app, '/lanes/mine', LIMIT + 1);

    expect((await request(app).get('/lanes/muted')).status).toBe(200);
  });
});
