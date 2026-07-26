import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';

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

/**
 * Emits bounded, structured request telemetry. It deliberately excludes the
 * URL, query string, authenticated subject and request body so identifiers,
 * tokens and private content never become log fields or metric labels.
 */
export function requestObservability(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const id = requestId(req);
  const startedAt = process.hrtime.bigint();
  res.setHeader('X-Request-ID', id);

  res.once('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const route = routeTemplate(req);
    const labels = {
      method: req.method.toUpperCase(),
      route,
      status: statusClass(res.statusCode),
    };
    metrics.recordLatency('http_request_duration_ms', durationMs, labels);
    metrics.incrementCounter('http_requests_total', 1, labels);
    logger.info('HTTP request completed', {
      requestId: id,
      method: labels.method,
      route,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });

  next();
}
