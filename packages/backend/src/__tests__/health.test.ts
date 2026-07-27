import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/database', () => ({
  isDatabaseConnected: vi.fn(),
}));

vi.mock('../utils/redis', () => ({
  getRedisStats: vi.fn(),
}));

import healthRoutes from '../routes/health.routes';
import { legacyApiRootReadiness } from '../routes/legacyRoot.routes';
import { isDatabaseConnected } from '../utils/database';
import { getRedisStats } from '../utils/redis';
import {
  markMigrationsComplete,
  markRuntimeReady,
  markRuntimeShuttingDown,
  resetRuntimeHealthState,
} from '../utils/runtimeHealth';

const mockIsDatabaseConnected = isDatabaseConnected as unknown as ReturnType<typeof vi.fn>;
const mockGetRedisStats = getRedisStats as unknown as ReturnType<typeof vi.fn>;

describe('health routes', () => {
  const app = express();
  app.use(healthRoutes);
  const legacyRootApp = express();
  legacyRootApp.get('/', legacyApiRootReadiness);

  beforeEach(() => {
    resetRuntimeHealthState();
    mockIsDatabaseConnected.mockReturnValue(false);
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
      migrations: 'ready',
      redis: 'degraded',
    });
  });

  it('drops readiness immediately when Mongo disconnects', async () => {
    markMigrationsComplete();
    markRuntimeReady();

    await request(app).get('/health/ready').expect(503);
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
  });
});
