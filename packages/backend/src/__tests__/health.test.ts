import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/database', () => ({
  isDatabaseConnected: vi.fn(),
}));

vi.mock('../db/postgres', () => ({
  checkPostgresHealth: vi.fn(),
}));

vi.mock('../utils/redis', () => ({
  getRedisStats: vi.fn(),
}));

import healthRoutes from '../routes/health.routes';
import { legacyApiRootReadiness } from '../routes/legacyRoot.routes';
import { checkPostgresHealth } from '../db/postgres';
import { isDatabaseConnected } from '../utils/database';
import { getRedisStats } from '../utils/redis';
import {
  markMigrationsComplete,
  markRuntimeReady,
  markRuntimeShuttingDown,
  resetRuntimeHealthState,
} from '../utils/runtimeHealth';

const mockIsDatabaseConnected = isDatabaseConnected as unknown as ReturnType<typeof vi.fn>;
const mockCheckPostgresHealth = checkPostgresHealth as unknown as ReturnType<typeof vi.fn>;
const mockGetRedisStats = getRedisStats as unknown as ReturnType<typeof vi.fn>;

describe('health routes', () => {
  const app = express();
  app.use(healthRoutes);
  const legacyRootApp = express();
  legacyRootApp.get('/', legacyApiRootReadiness);

  beforeEach(() => {
    resetRuntimeHealthState();
    mockIsDatabaseConnected.mockReturnValue(false);
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
    expect(response.body.dependencies.mongo).toBe('unavailable');
  });

  it('becomes ready only after migrations and Mongo are ready', async () => {
    mockIsDatabaseConnected.mockReturnValue(true);
    mockGetRedisStats.mockReturnValue({
      connected: false,
      status: 'disconnected',
    });
    markMigrationsComplete();
    markRuntimeReady();

    const response = await request(app).get('/health/ready').expect(200);
    expect(response.body.dependencies).toEqual({
      mongo: 'ready',
      postgres: 'ready',
      migrations: 'ready',
      redis: 'degraded',
    });
  });

  it('drops readiness immediately when Mongo disconnects', async () => {
    markMigrationsComplete();
    markRuntimeReady();

    await request(app).get('/health/ready').expect(503);
  });

  it('drops readiness when POSTGRES stops answering', async () => {
    // The case this endpoint was blind to. Before the cutover it checked Mongo
    // and not Postgres at all, so a task whose Postgres had become unreachable
    // kept reporting ready and kept taking traffic while erroring on every
    // request. Everything else here is healthy, so only the new gate can fail.
    mockIsDatabaseConnected.mockReturnValue(true);
    mockCheckPostgresHealth.mockResolvedValue(false);
    markMigrationsComplete();
    markRuntimeReady();

    const response = await request(app).get('/health/ready').expect(503);
    expect(response.body.dependencies.postgres).toBe('unavailable');
    // And it says which one, because "not_ready" alone sends an operator to
    // check all four.
    expect(response.body.dependencies.mongo).toBe('ready');
  });

  it('is a real query, not a pool-exists check', async () => {
    // `isPostgresConnected()` would answer "was a pool ever built", which is
    // TRUE of exactly the task that is failing every query. The endpoint has to
    // call the one that issues `select 1`.
    mockIsDatabaseConnected.mockReturnValue(true);
    markMigrationsComplete();
    markRuntimeReady();

    await request(app).get('/health/ready').expect(200);
    expect(mockCheckPostgresHealth).toHaveBeenCalled();
  });

  it('keeps liveness but drops readiness while draining', async () => {
    mockIsDatabaseConnected.mockReturnValue(true);
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

    mockIsDatabaseConnected.mockReturnValue(true);
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
