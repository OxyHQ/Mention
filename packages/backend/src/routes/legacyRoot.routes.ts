import type { NextFunction, Request, Response } from 'express';
import { checkPostgresHealth } from '../db/postgres';
import { isApexHost } from '../middleware/apexFrontendProxy';
import { getRuntimeHealthState } from '../utils/runtimeHealth';

/**
 * Temporary ALB compatibility handler while target groups converge from `/` to
 * `/health/ready`. Apex browser traffic must continue to the SPA proxy.
 */
export async function legacyApiRootReadiness(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<Response | void> {
  if (isApexHost(req)) {
    next();
    return;
  }

  const runtime = getRuntimeHealthState();
  // The SAME predicate as `/health/ready`, Postgres included. These two answer
  // one question for one ALB, and a target group still pointed at `/` must not
  // get a more forgiving answer than the endpoint it is converging to.
  const ready =
    runtime.phase === 'ready' &&
    runtime.migrationsComplete &&
    (await checkPostgresHealth());

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
