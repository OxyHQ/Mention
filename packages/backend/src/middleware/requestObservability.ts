import { randomUUID } from 'crypto';
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

function routeTemplate(req: Request): string {
  const route = req.route as { path?: unknown } | undefined;
  if (typeof route?.path !== 'string') return '/unmatched';
  const joined = `${req.baseUrl ?? ''}${route.path}`;
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
  const route = routeTemplate(req);
  const labels = {
    method: req.method.toUpperCase(),
    route,
    status: statusClass(res.statusCode),
  };
  metrics.recordLatency('http_request_duration_ms', durationMs, labels);
  metrics.incrementCounter('http_requests_total', 1, labels);

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
    // The line, not the histogram, is what survives the process: nothing scrapes
    // `/internal/metrics` (see `docs/PERFORMANCE_BUDGETS.md`). Read beside
    // `queryCount`, these two say whether a slow route is slow in Postgres or
    // slow waiting on Oxy — which no existing signal could distinguish.
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
export function requestObservability(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
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
