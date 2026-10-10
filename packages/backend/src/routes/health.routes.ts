import { Router } from 'express';
import { checkPostgresHealth } from '../db/postgres';
import { getRedisStats } from '../utils/redis';
import { getRuntimeHealthState } from '../utils/runtimeHealth';

const router = Router();

router.get('/health/live', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // A process that can answer this request is alive. Draining is represented
  // exclusively by readiness so an orchestrator does not mistake a graceful
  // shutdown for a wedged process.
  res.status(200).json({ status: 'alive' });
});

/**
 * Readiness gates on POSTGRES, and on nothing else that is a data store.
 *
 * Postgres is checked with `checkPostgresHealth()`, which issues a real
 * `select 1` rather than reading a connection flag: the failure this exists to
 * catch is a task whose database has become UNREACHABLE, and a pool object
 * survives that. `isPostgresConnected()` would answer "was a pool ever built",
 * which is true of exactly the task that is failing every request.
 *
 * ## No other data store is part of this gate
 *
 * `dependencies` reports only stores this process actually opens; reporting one
 * it never opens would be inventing a status, and gating on one would let a
 * store no request touches drain the fleet through `/health/ready`.
 */
router.get('/health/ready', async (_req, res) => {
  const runtime = getRuntimeHealthState();
  const postgresReady = await checkPostgresHealth();
  const redis = getRedisStats();
  const ready = runtime.phase === 'ready' && runtime.migrationsComplete && postgresReady;

  res.setHeader('Cache-Control', 'no-store');
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    phase: runtime.phase,
    dependencies: {
      postgres: postgresReady ? 'ready' : 'unavailable',
      migrations: runtime.migrationsComplete ? 'ready' : 'pending',
      // Redis is intentionally non-blocking for HTTP readiness. Singleton jobs
      // independently fail closed when they cannot hold the Redis lease.
      redis: redis.connected ? 'ready' : 'degraded',
    },
  });
});

export default router;
