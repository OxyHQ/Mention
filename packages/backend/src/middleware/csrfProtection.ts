import type { NextFunction, Request, Response } from 'express';
import { isAllowedOrigin } from '../utils/allowedOrigins';
import { logger } from '../utils/logger';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function getOriginFromReferer(referer: string | undefined): string | undefined {
  if (!referer) return undefined;

  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/**
 * Reject browser-originated cross-site state-changing requests before auth.
 *
 * CORS does not stop HTML form CSRF, so authenticated API routes need a server-
 * side same-origin check when a browser supplies Origin/Referer metadata. Non-
 * browser clients and native apps commonly omit both headers, so headerless
 * requests are allowed and still rely on normal Oxy authentication.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    return next();
  }

  const origin = getHeaderValue(req.headers.origin);
  const refererOrigin = getOriginFromReferer(getHeaderValue(req.headers.referer));
  const requestOrigin = origin || refererOrigin;

  if (!requestOrigin) {
    return next();
  }

  if (isAllowedOrigin(requestOrigin)) {
    return next();
  }

  logger.warn('Blocked cross-site state-changing request', {
    method: req.method,
    path: req.originalUrl || req.url,
    origin,
    refererOrigin,
  });

  return res.status(403).json({ error: 'Forbidden' });
}
