import { publicDeploymentInfo } from '@mention/shared-types/deployment';
import type { RequestHandler } from 'express';
import { OxyServices } from '@oxy.so/core';
import { createOxyRateLimit } from '@oxy.so/core/server';
import { createApp } from './app';
import { appRoutePredicates, createAppRoutes } from './appRoutes';
import { config } from './config';
import { initConnectors } from './connectors';
import { RedisStore } from './middleware/rateLimitStore';
import { bruteForceProtection } from './middleware/security';
import { createOptionalAuth } from './middleware/optionalAuth';
import { requestObservability } from './middleware/requestObservability';
import { count, sql } from 'drizzle-orm';
import { getDb } from './db/postgres';
import { posts } from './db/schema/posts';
import { setRuntimeOxyClient } from './runtime/oxyClient';
import { globalErrorHandler } from './utils/error';
import { isAllowedOrigin } from './utils/allowedOrigins';
import { logger } from './utils/logger';
import { createCache } from './utils/cache';

/**
 * Nodeinfo's `localPosts`: the planner's row estimate, refreshed hourly.
 *
 * A federation-discovery statistic that other instances poll — approximate to
 * its consumers by nature. It used to be an exact `count(*)` cached for five
 * minutes, and that was still a sequential scan of `posts` (1.46M rows, 1 GB)
 * every time the entry expired: ~3.8 s and ~70k shared buffers per call, ~70
 * calls a day in Performance Insights, each holding a request-pool connection
 * and pushing hot pages out of the buffer cache (#1160). Nobody reading
 * nodeinfo can tell an hour-old estimate from a live count.
 *
 * `pg_class.reltuples` is what autovacuum's ANALYZE last measured, so it is
 * free to read and as fresh as the table's statistics. It is `-1` on a table
 * that has never been analyzed — a freshly migrated instance, the case the old
 * comment here worried about — and only then does this pay for an exact count.
 *
 * Stale-while-revalidate: an entry older than an hour is still served while one
 * background refresh runs, so no poller ever waits on the database, and a crawl
 * storm collapses onto one refresh per process (`getOrCompute`'s single-flight).
 *
 * Module scope rather than inside `createRuntimeApp`: a cache built per call
 * would silently lose its single-flight the moment anything constructed a
 * second app (a test harness, most likely).
 */
const NODEINFO_POST_COUNT_FRESH_MS = 60 * 60 * 1000;
const NODEINFO_POST_COUNT_TTL_SECONDS = 24 * 60 * 60;
const NODEINFO_POST_COUNT_KEY = 'nodeinfo:v2:localposts';
const nodeinfoPostCountCache = createCache({
  name: 'NodeinfoPostCountCache',
  ttlSeconds: NODEINFO_POST_COUNT_TTL_SECONDS,
  staleAfterMs: NODEINFO_POST_COUNT_FRESH_MS,
});

/** The planner's row estimate for `posts`, or an exact count if it has none. */
export async function estimatePostCount(): Promise<number> {
  const [estimate] = await getDb().execute<{ estimate: number }>(
    sql`select reltuples::float8 as estimate from pg_class where oid = to_regclass('posts')`,
  );
  const reltuples = Number(estimate?.estimate);
  if (Number.isFinite(reltuples) && reltuples >= 0) return Math.round(reltuples);
  const [row] = await getDb().select({ count: count() }).from(posts);
  return row?.count ?? 0;
}

/**
 * `localPosts` for `GET /nodeinfo/2.0`, served from {@link nodeinfoPostCountCache}.
 *
 * Exported so the cache's behaviour is testable without standing up the whole
 * runtime app — `createRuntimeApp` constructs Oxy, Redis stores, connectors and
 * every route, none of which this needs.
 */
export function countLocalPostsCached(): Promise<number> {
  return nodeinfoPostCountCache.getOrCompute(NODEINFO_POST_COUNT_KEY, estimatePostCount);
}

/** Compose production HTTP dependencies. Runtime bootstrap calls this once. */
export function createRuntimeApp(activity?: RequestHandler) {
  initConnectors();

  // `serviceIdentity`: this client never holds a user session, so without it
  // every read it makes (web-shell profiles, `getUserById` fallbacks, `from:`
  // operators) went out anonymous and was charged to the cluster's one NAT
  // address, paying oxy-api's +500 ms `slowDown` past 100 anonymous requests
  // per 15 minutes (#1173). With it they carry Mention's service token.
  const oxy = new OxyServices({ baseURL: config.oxyApiUrl, serviceIdentity: 'when-anonymous' });
  setRuntimeOxyClient(oxy);

  // `rate-limit:api:` belongs to THIS limiter — the app-wide one, whose scope is
  // the entire API surface. Route-level limiters must not reuse it: they key
  // authenticated callers as `user:<id>` exactly as this one does, so a shared
  // prefix is a shared counter, and the Lua in `rateLimitStore` hands the whole
  // key one TTL — whichever limiter creates it. See `middleware/rateLimiter.ts`.
  const redisStore = new RedisStore({
    prefix: 'rate-limit:api:',
    windowMs: 15 * 60 * 1000,
  });
  const rateLimiter = createOxyRateLimit(oxy, { store: redisStore });
  const optionalAuth = createOptionalAuth(oxy);
  const routes = createAppRoutes({ oxy, optionalAuth });

  const app = createApp({
    deployment: config.deployment ? publicDeploymentInfo(config.deployment) : undefined,
    frontendUrl: config.frontendUrl,
    federationDomain: config.federationDomain,
    isAllowedOrigin,
    ...appRoutePredicates,
    // An hourly planner estimate, never a scan per poller — see
    // `countLocalPostsCached`.
    countLocalPosts: countLocalPostsCached,
    logger,
    middleware: {
      activity,
      requestObservability,
      rateLimiter,
      bruteForceProtection,
      globalErrorHandler,
    },
    routes,
  });

  return { app, oxy };
}
