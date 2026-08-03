import { Router } from 'express';
import { checkPostgresHealth } from '../db/postgres';
import { isDatabaseConnected } from '../utils/database';
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
 * Readiness gates on POSTGRES, and the asymmetry with Mongo below is deliberate.
 *
 * Mongo is checked with `isDatabaseConnected()` — a synchronous `readyState`
 * read, no command, because a probe must not cost a round trip per call.
 * Postgres is checked with `checkPostgresHealth()`, which issues a real
 * `select 1`, and the difference is the whole point: the failure this exists to
 * catch is a task whose database has become UNREACHABLE, and a pool object
 * survives that. `isPostgresConnected()` would answer "was a pool ever built",
 * which is true of exactly the task that is failing every query.
 *
 * Before the Mongo→Postgres cutover this endpoint checked Mongo and not
 * Postgres at all. That matched which store was authoritative, and it inverts
 * the moment the data moves: a task with no Postgres connection kept reporting
 * ready and kept taking traffic while erroring on every request. `postgres.ts`
 * already said the health endpoint was the caller `checkPostgresHealth` existed
 * for; it simply was not wired.
 *
 * Mongo stays in the gate while Mongo is still running. Removing it is
 * decommission work, and it must be removed rather than left: once Mongo is off,
 * `isDatabaseConnected()` pins readiness false forever.
 */
router.get('/health/ready', async (_req, res) => {
  const runtime = getRuntimeHealthState();
  const mongoReady = isDatabaseConnected();
  const postgresReady = await checkPostgresHealth();
  const redis = getRedisStats();
  const ready =
    runtime.phase === 'ready' &&
    runtime.migrationsComplete &&
    mongoReady &&
    postgresReady;

  res.setHeader('Cache-Control', 'no-store');
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    phase: runtime.phase,
    dependencies: {
      mongo: mongoReady ? 'ready' : 'unavailable',
      postgres: postgresReady ? 'ready' : 'unavailable',
      migrations: runtime.migrationsComplete ? 'ready' : 'pending',
      // Redis is intentionally non-blocking for HTTP readiness. Singleton jobs
      // independently fail closed when they cannot hold the Redis lease.
      redis: redis.connected ? 'ready' : 'degraded',
    },
  });
});

export default router;
