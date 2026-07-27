import { Router } from 'express';
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

router.get('/health/ready', (_req, res) => {
  const runtime = getRuntimeHealthState();
  const mongoReady = isDatabaseConnected();
  const redis = getRedisStats();
  const ready =
    runtime.phase === 'ready' &&
    runtime.migrationsComplete &&
    mongoReady;

  res.setHeader('Cache-Control', 'no-store');
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    phase: runtime.phase,
    dependencies: {
      mongo: mongoReady ? 'ready' : 'unavailable',
      migrations: runtime.migrationsComplete ? 'ready' : 'pending',
      // Redis is intentionally non-blocking for HTTP readiness. Singleton jobs
      // independently fail closed when they cannot hold the Redis lease.
      redis: redis.connected ? 'ready' : 'degraded',
    },
  });
});

export default router;
