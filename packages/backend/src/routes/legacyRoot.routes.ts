import type { NextFunction, Request, Response } from 'express';
import { isApexHost } from '../middleware/apexFrontendProxy';
import { isDatabaseConnected } from '../utils/database';
import { getRuntimeHealthState } from '../utils/runtimeHealth';

/**
 * Temporary ALB compatibility handler while target groups converge from `/` to
 * `/health/ready`. Apex browser traffic must continue to the SPA proxy.
 */
export function legacyApiRootReadiness(
  req: Request,
  res: Response,
  next: NextFunction,
): Response | void {
  if (isApexHost(req)) {
    next();
    return;
  }

  const runtime = getRuntimeHealthState();
  const ready =
    runtime.phase === 'ready' &&
    runtime.migrationsComplete &&
    isDatabaseConnected();

  res.setHeader('Cache-Control', 'no-store');
  return res
    .status(ready ? 200 : 503)
    .json({
      message: 'Welcome to the Mention API',
      status: ready ? 'ready' : 'not_ready',
      capabilities: {
        // Frontend releases can precede the backend rollout. Advertising the
        // anonymous endpoint prevents a newer web client from POSTing RUM to an
        // older revision where the path falls through to required auth.
        webTelemetry: true,
      },
    });
}
