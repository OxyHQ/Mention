import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/postgres', () => ({
  checkPostgresHealth: vi.fn(),
}));

vi.mock('../utils/redis', () => ({
  getRedisStats: vi.fn(),
}));

import healthRoutes from '../routes/health.routes';
import { legacyApiRootReadiness } from '../routes/legacyRoot.routes';
import { checkPostgresHealth } from '../db/postgres';
import { getRedisStats } from '../utils/redis';
import {
  markMigrationsComplete,
  markRuntimeReady,
  markRuntimeShuttingDown,
  resetRuntimeHealthState,
} from '../utils/runtimeHealth';

const mockCheckPostgresHealth = checkPostgresHealth as unknown as ReturnType<typeof vi.fn>;
const mockGetRedisStats = getRedisStats as unknown as ReturnType<typeof vi.fn>;

describe('health routes', () => {
  const app = express();
  app.use(healthRoutes);
  const legacyRootApp = express();
  legacyRootApp.get('/', legacyApiRootReadiness);

  beforeEach(() => {
    resetRuntimeHealthState();
    // Healthy by default so each case states the ONE dependency it is about.
    mockCheckPostgresHealth.mockResolvedValue(true);
    mockGetRedisStats.mockReturnValue({
      connected: false,
      status: 'not_initialized',
    });
  });

  it('keeps liveness available while the process is starting', async () => {
    const response = await request(app).get('/health/live').expect(200);
    expect(response.body).toEqual({ status: 'alive' });
  });

  it('returns 503 readiness before boot and migrations complete', async () => {
    const response = await request(app).get('/health/ready').expect(503);
    expect(response.body.status).toBe('not_ready');
    expect(response.body.dependencies.migrations).toBe('pending');
  });

  /**
   * The dependency list is asserted WHOLE: a `toEqual` fails if a dependency is
   * added or dropped. The endpoint must not report a store this process never
   * opens.
   */
  it('becomes ready on migrations and Postgres alone', async () => {
    mockGetRedisStats.mockReturnValue({
      connected: false,
      status: 'disconnected',
    });
    markMigrationsComplete();
    markRuntimeReady();

    const response = await request(app).get('/health/ready').expect(200);
    expect(response.body.dependencies).toEqual({
      postgres: 'ready',
      migrations: 'ready',
      redis: 'degraded',
    });
  });

  it('drops readiness when POSTGRES stops answering', async () => {
    // A task whose Postgres has become unreachable must stop reporting ready,
    // or it keeps taking traffic while erroring on every request. Everything else here is healthy, so only this gate can fail.
    mockCheckPostgresHealth.mockResolvedValue(false);
    markMigrationsComplete();
    markRuntimeReady();

    const response = await request(app).get('/health/ready').expect(503);
    // And it says WHICH one, because "not_ready" alone sends an operator to
    // check every dependency in the list.
    expect(response.body.dependencies.postgres).toBe('unavailable');
    expect(response.body.dependencies.migrations).toBe('ready');
  });

  it('is a real query, not a pool-exists check', async () => {
    // `isPostgresConnected()` would answer "was a pool ever built", which is
    // TRUE of exactly the task that is failing every query. The endpoint has to
    // call the one that issues `select 1`.
    markMigrationsComplete();
    markRuntimeReady();

    await request(app).get('/health/ready').expect(200);
    expect(mockCheckPostgresHealth).toHaveBeenCalled();
  });

  it('keeps liveness but drops readiness while draining', async () => {
    markMigrationsComplete();
    markRuntimeReady();
    markRuntimeShuttingDown();

    await request(app).get('/health/live').expect(200);
    await request(app).get('/health/ready').expect(503);
  });

  it('keeps the legacy API root aligned with readiness during target-group migration', async () => {
    const starting = await request(legacyRootApp)
      .get('/')
      .set('Host', 'api.mention.earth')
      .expect(503);
    expect(starting.body.status).toBe('not_ready');

    markMigrationsComplete();
    markRuntimeReady();

    const ready = await request(legacyRootApp)
      .get('/')
      .set('Host', 'api.mention.earth')
      .expect(200);
    expect(ready.body).toEqual({
      message: 'Welcome to the Mention API',
      status: 'ready',
      capabilities: {
        webTelemetry: true,
      },
    });
    expect(ready.headers['cache-control']).toBe('no-store');

    // Same predicate as `/health/ready`: one ALB, one question. A target group
    // still pointed at `/` must not get the more forgiving answer.
    mockCheckPostgresHealth.mockResolvedValue(false);
    await request(legacyRootApp).get('/').set('Host', 'api.mention.earth').expect(503);
  });
});
