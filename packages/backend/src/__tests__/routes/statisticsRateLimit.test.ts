import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rate limiting on the statistics router (CodeQL `js/missing-rate-limiting`,
 * high severity, originally raised against `POST /post/:postId/view`).
 *
 * Two properties are pinned here, because each fails in a way the other would
 * not catch:
 *
 *  1. The bound covers the WHOLE router, not just the route the CodeQL dataflow
 *     reached. Every handler in `statistics.controller` queries the database —
 *     the insights route runs three parallel counts, and the public
 *     heatmap aggregates a caller-chosen window — so a fix that guarded one line
 *     and left five siblings would be a fix in name only. Each route is
 *     exercised individually rather than sampled.
 *
 *  2. The view route's budget is SEPARATE from the router's. That is the whole
 *     reason it is not `feedRateLimiter`: sharing a store couples two unrelated
 *     budgets, and a viewer opening posts would start getting throttled while
 *     scrolling. A shared store would sail through property 1.
 *
 * The real limiters run; only their Redis store is swapped for an in-memory one,
 * because `RedisStore` deliberately degrades OPEN when Redis is absent
 * (`increment` falls back to `{ totalHits: 1 }`) and would therefore never
 * throttle under test — a test that cannot fail.
 */

const { MemoryStore, ok } = vi.hoisted(() => {
  /** Per-instance in-memory stand-in for `RedisStore`, same surface, no Redis. */
  class MemoryStore {
    private hits = new Map<string, number>();
    readonly prefix: string;

    constructor(options: { prefix?: string } = {}) {
      this.prefix = options.prefix ?? 'rate-limit:';
    }

    init(): void {
      // express-rate-limit hands the window in; this store never expires entries
      // because every test asserts within a single window.
    }

    async increment(key: string): Promise<{ totalHits: number; resetTime: Date | undefined }> {
      const next = (this.hits.get(key) ?? 0) + 1;
      this.hits.set(key, next);
      return { totalHits: next, resetTime: undefined };
    }

    async decrement(key: string): Promise<void> {
      this.hits.set(key, Math.max(0, (this.hits.get(key) ?? 0) - 1));
    }

    async resetKey(key: string): Promise<void> {
      this.hits.delete(key);
    }
  }

  // The controller is not under test — every handler is stubbed to a bare 200 so
  // a request's only observable cost is the limiter it passed through.
  return {
    MemoryStore,
    ok: (_req: unknown, res: { json: (body: unknown) => void }) => {
      res.json({ ok: true });
    },
  };
});

vi.mock('../../middleware/rateLimitStore', () => ({ RedisStore: MemoryStore }));

vi.mock('../../controllers/statistics.controller', () => ({
  getUserStatistics: ok,
  getUserActivity: ok,
  getPostInsights: ok,
  trackPostView: ok,
  getFollowerChanges: ok,
  getEngagementRatios: ok,
  getWeeklySummary: ok,
}));

import statisticsRoutes, { publicStatisticsRouter } from '../../routes/statistics.routes';

/** Limits copied from `middleware/security.ts`; a drift here is a real failure. */
const ROUTER_MAX = 200;
const POST_VIEW_MAX = 120;

/**
 * Mount both routers behind an authenticated identity, so every request keys to
 * a known bucket rather than to the key generator's IP fallback.
 *
 * The identity is UNIQUE per app by default. The limiters are module-level
 * singletons created at import — one store each, shared by every test in this
 * file — so a fixed id would let one test's hammering spend the next test's
 * budget, and the failure would look like an over-tight limit rather than
 * cross-test bleed.
 */
let identityCounter = 0;
function buildApp(userId = `viewer-${(identityCounter += 1)}`) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: string } }).user = { id: userId };
    next();
  });
  app.use('/statistics', statisticsRoutes);
  app.use('/public-statistics', publicStatisticsRouter);
  return app;
}

/** Issue `count` sequential GET/POSTs and return the last status seen. */
async function hammer(
  app: express.Express,
  method: 'get' | 'post',
  path: string,
  count: number,
): Promise<number> {
  let status = 0;
  for (let i = 0; i < count; i += 1) {
    status = (await request(app)[method](path)).status;
  }
  return status;
}

const AUTHENTICATED_ROUTES: [string, string][] = [
  ['/statistics/user', 'get'],
  ['/statistics/post/abc', 'get'],
  ['/statistics/followers', 'get'],
  ['/statistics/engagement', 'get'],
  ['/statistics/weekly-summary', 'get'],
];

describe('statistics router rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(AUTHENTICATED_ROUTES)('bounds %s', async (path, method) => {
    const app = buildApp();

    expect(await hammer(app, method as 'get', path, ROUTER_MAX)).toBe(200);
    expect(await hammer(app, method as 'get', path, 1)).toBe(429);
  });

  it('bounds the public activity route, which an anonymous caller can reach', async () => {
    const app = buildApp();

    expect(await hammer(app, 'get', '/public-statistics/user/someone/activity', ROUTER_MAX)).toBe(200);
    expect(await hammer(app, 'get', '/public-statistics/user/someone/activity', 1)).toBe(429);
  });

  it('bounds the view write more tightly than the router does', async () => {
    const app = buildApp();

    // Tighter: the write is capped before the router's own ceiling is reached.
    expect(await hammer(app, 'post', '/statistics/post/abc/view', POST_VIEW_MAX)).toBe(200);
    expect(await hammer(app, 'post', '/statistics/post/abc/view', 1)).toBe(429);
    expect(POST_VIEW_MAX).toBeLessThan(ROUTER_MAX);
  });

  it('keeps the view budget separate from the read budget', async () => {
    // The reason this is not `feedRateLimiter`, and the reason the two limiters
    // need distinct Redis prefixes: one store for both would mean opening posts
    // silently spends the budget for reading statistics (and, with the feed's
    // store, for scrolling).
    const app = buildApp();

    await hammer(app, 'post', '/statistics/post/abc/view', POST_VIEW_MAX);
    expect(await hammer(app, 'post', '/statistics/post/abc/view', 1)).toBe(429);

    // The read side is untouched by all of that.
    expect(await hammer(app, 'get', '/statistics/user', 1)).toBe(200);
  });

  it('buckets per viewer, so one caller cannot throttle another', async () => {
    const noisy = buildApp();
    await hammer(noisy, 'post', '/statistics/post/abc/view', POST_VIEW_MAX);
    expect(await hammer(noisy, 'post', '/statistics/post/abc/view', 1)).toBe(429);

    // A different identity against the SAME module-level limiter instance.
    const quiet = buildApp();
    expect(await hammer(quiet, 'post', '/statistics/post/abc/view', 1)).toBe(200);
  });
});
