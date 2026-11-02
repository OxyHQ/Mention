import { publicDeploymentInfo } from '@mention/shared-types/deployment';
import type { RequestHandler } from 'express';
import { createOxyRateLimit } from '@oxy.so/core/server';
import { createApp } from './app';
import { appRoutePredicates, createAppRoutes } from './appRoutes';
import { config } from './config';
import { initConnectors } from './connectors';
import { RedisStore } from './middleware/rateLimitStore';
import { bruteForceProtection } from './middleware/security';
import { createOptionalAuth } from './middleware/optionalAuth';
import { routeRateLimitByBearer } from './mcp/middleware/mcpRateLimiter';
import { requestObservability } from './middleware/requestObservability';
import { contentAccessScope } from './services/contentAccessBatcher';
import {
  measureNodeinfoStatistics,
  type NodeinfoLocalUsers,
  type NodeinfoStatistics,
} from './services/nodeinfoStatistics';
import { getRuntimeOxyClient } from './runtime/oxyClient';
import { globalErrorHandler } from './utils/error';
import { isAllowedOrigin } from './utils/allowedOrigins';
import { logger } from './utils/logger';
import { createCache } from './utils/cache';

/**
 * Nodeinfo statistics (`services/nodeinfoStatistics.ts`), refreshed hourly from planner estimates and one index-only count.
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
const NODEINFO_STATS_FRESH_MS = 60 * 60 * 1000;
const NODEINFO_STATS_TTL_SECONDS = 24 * 60 * 60;
// Bump the version whenever `NodeinfoStatistics` changes shape: Redis keeps the old
// envelope for a day, and an old entry read as the new shape 500s the endpoint.
const NODEINFO_STATS_KEY = 'nodeinfo:v4:statistics';
const nodeinfoStatsCache = createCache({
  name: 'NodeinfoStatisticsCache',
  ttlSeconds: NODEINFO_STATS_TTL_SECONDS,
  staleAfterMs: NODEINFO_STATS_FRESH_MS,
});

/**
 * Cached statistics for `GET /nodeinfo/2.0`: stale-while-revalidate with a
 * per-process single-flight. A failed refresh keeps serving the last good entry;
 * with none, it rejects and the route omits the counts.
 */
export function nodeinfoStatisticsCached(): Promise<NodeinfoStatistics> {
  return nodeinfoStatsCache.getOrCompute(NODEINFO_STATS_KEY, () => measureNodeinfoStatistics());
}

const NODEINFO_USERS_KEY = 'nodeinfo:v1:local-users';
// Oxy's snapshot is already bounded (5-minute recount); this only collapses pollers.
const nodeinfoUsersCache = createCache({
  name: 'NodeinfoLocalUsersCache',
  ttlSeconds: NODEINFO_STATS_TTL_SECONDS,
  staleAfterMs: 10 * 60 * 1000,
});

/**
 * Oxy's registered-account total, stale-while-revalidate. A failed refresh keeps
 * the last good value; with none it rejects and the route omits the field.
 */
export function nodeinfoLocalUsersCached(): Promise<NodeinfoLocalUsers> {
  return nodeinfoUsersCache.getOrCompute(NODEINFO_USERS_KEY, async () => {
    const snapshot = await getRuntimeOxyClient().applicationAccountTotal();
    return {
      total: snapshot.total,
      exact: snapshot.exact,
      computedAt: snapshot.computedAt,
      stale: snapshot.stale,
    };
  });
}

/** Compose production HTTP dependencies. Runtime bootstrap calls this once. */
export function createRuntimeApp(activity?: RequestHandler) {
  initConnectors();

  // `serviceIdentity`: this client never holds a user session, so without it
  // every read it makes (web-shell profiles, `users.get` fallbacks, `from:`
  // operators) went out anonymous and was charged to the cluster's one NAT
  // address, paying oxy-api's +500 ms `slowDown` past 100 anonymous requests
  // per 15 minutes (#1173). With it they carry Mention's service token.
  const oxy = getRuntimeOxyClient();

  // `rate-limit:api:` belongs to THIS limiter — the app-wide one, whose scope is
  // the entire API surface. Route-level limiters must not reuse it: they key
  // authenticated callers as `user:<id>` exactly as this one does, so a shared
  // prefix is a shared counter, and the Lua in `rateLimitStore` hands the whole
  // key one TTL — whichever limiter creates it. See `middleware/rateLimiter.ts`.
  const redisStore = new RedisStore({
    prefix: 'rate-limit:api:',
    windowMs: 15 * 60 * 1000,
  });
  const rateLimiter = routeRateLimitByBearer(createOxyRateLimit(oxy, { store: redisStore }));
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
    getNodeinfoStatistics: nodeinfoStatisticsCached,
    getNodeinfoLocalUsers: nodeinfoLocalUsersCached,
    logger,
    middleware: {
      activity,
      requestObservability,
      contentAccessScope,
      rateLimiter,
      bruteForceProtection,
      globalErrorHandler,
    },
    routes,
  });

  return { app, oxy };
}
