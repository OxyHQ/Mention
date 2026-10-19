import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  isQueryInstrumentationEnabled,
  runWithQueryAccounting,
  type QueryTally,
} from '../db/queryMetrics';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import {
  isOxyInstrumentationEnabled,
  runWithOxyAccounting,
  type OxyTally,
} from '../utils/oxyMetrics';

const SAFE_REQUEST_ID = /^[a-zA-Z0-9_.:-]{8,128}$/;

function requestId(req: Request): string {
  const incoming = req.header('x-request-id')?.trim();
  return incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * The template a RegExp route path is reported as. Express reports a RegExp
 * route's `path` as the RegExp itself, so without a name every request it
 * served was counted as `/unmatched` — which is how the apex's crawled post
 * pages, the backend's busiest route, hid under that label.
 */
const namedPatterns = new WeakMap<RegExp, string>();

/**
 * Give a RegExp route path the template its requests are reported under, and
 * return the pattern unchanged so it can be passed straight to `router.get`.
 * The name is a literal from code, never request input, so it is a bounded
 * label.
 */
export function namedRoutePattern(pattern: RegExp, template: string): RegExp {
  namedPatterns.set(pattern, template);
  return pattern;
}

/** `res.locals` key a middleware that answers without a route sets to name itself. */
const MIDDLEWARE_LABEL = 'observabilityRoute';

/**
 * Report a response answered by middleware rather than a route (the apex
 * frontend proxy) under its own name instead of `/unmatched`. `label` must be
 * a literal from code.
 */
export function labelMiddlewareResponse(res: Response, label: string): void {
  res.locals[MIDDLEWARE_LABEL] = label;
}

function routeTemplate(req: Request, res: Response): string {
  const labelled = res.locals?.[MIDDLEWARE_LABEL];
  if (typeof labelled === 'string') return labelled;
  const route = req.route as { path?: unknown } | undefined;
  const path =
    typeof route?.path === 'string'
      ? route.path
      : route?.path instanceof RegExp
        ? (namedPatterns.get(route.path) ?? '/unnamed-pattern')
        : undefined;
  if (path === undefined) return '/unmatched';
  const joined = `${req.baseUrl ?? ''}${path}`;
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function statusClass(statusCode: number): string {
  const bucket = Math.floor(statusCode / 100);
  return bucket >= 1 && bucket <= 5 ? `${bucket}xx` : 'other';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Emit the request's own telemetry, plus what it cost the database when query
 * instrumentation is on.
 *
 * `tally` is read here rather than copied at `next()` time because it keeps
 * accumulating for the life of the request; `finish` is the first moment its
 * value is the whole answer.
 */
function reportRequest(
  req: Request,
  res: Response,
  id: string,
  startedAt: bigint,
  tally: QueryTally | undefined,
  oxyTally: OxyTally | undefined,
): void {
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const route = routeTemplate(req, res);
  const labels = {
    method: req.method.toUpperCase(),
    route,
    status: statusClass(res.statusCode),
  };
  // Its count is the request count: there is no separate requests counter.
  metrics.recordLatency('http_request_duration_ms', durationMs, labels);

  const perRequestLabels = { method: labels.method, route };
  if (tally) {
    metrics.observeValue('db_request_queries', tally.count, perRequestLabels);
    metrics.recordLatency('db_request_duration_ms', tally.totalDurationMs, perRequestLabels);
  }
  if (oxyTally) {
    metrics.observeValue('oxy_request_calls', oxyTally.count, perRequestLabels);
    metrics.recordLatency('oxy_request_duration_ms', oxyTally.totalDurationMs, perRequestLabels);
  }

  logger.info('HTTP request completed', {
    requestId: id,
    method: labels.method,
    route,
    statusCode: res.statusCode,
    durationMs: round(durationMs),
    ...(tally
      ? {
          queryCount: tally.count,
          queryDurationMs: round(tally.totalDurationMs),
          slowQueryCount: tally.slowCount,
          failedQueryCount: tally.errorCount,
        }
      : {}),
    // Read beside `queryCount`, these two say whether a slow route is slow in
    // Postgres or slow waiting on Oxy — which no existing signal could
    // distinguish.
    ...(oxyTally
      ? {
          oxyCallCount: oxyTally.count,
          oxyDurationMs: round(oxyTally.totalDurationMs),
          failedOxyCallCount: oxyTally.errorCount,
        }
      : {}),
  });
}

/**
 * Emits bounded, structured request telemetry. It deliberately excludes the
 * URL, query string, authenticated subject and request body so identifiers,
 * tokens and private content never become log fields or metric labels.
 *
 * When query instrumentation is enabled this also opens the async context every
 * database statement issued while serving the request is counted against — so
 * the request reports how many round trips it made and how long they took, not
 * only its own wall clock. With it disabled the request never enters that
 * context at all.
 */
export function requestObservability(req: Request, res: Response, next: NextFunction): void {
  const id = requestId(req);
  const startedAt = process.hrtime.bigint();
  res.setHeader('X-Request-ID', id);

  // The two accountings are independent flags, so all four combinations are
  // reachable and each context is opened only when its own is on.
  const withOxyAccounting = (report: (oxyTally: OxyTally | undefined) => void): void => {
    if (!isOxyInstrumentationEnabled()) {
      report(undefined);
      return;
    }
    runWithOxyAccounting((oxyTally) => report(oxyTally));
  };

  if (!isQueryInstrumentationEnabled()) {
    withOxyAccounting((oxyTally) => {
      res.once('finish', () => reportRequest(req, res, id, startedAt, undefined, oxyTally));
      next();
    });
    return;
  }

  runWithQueryAccounting((tally) => {
    withOxyAccounting((oxyTally) => {
      res.once('finish', () => reportRequest(req, res, id, startedAt, tally, oxyTally));
      next();
    });
  });
}
