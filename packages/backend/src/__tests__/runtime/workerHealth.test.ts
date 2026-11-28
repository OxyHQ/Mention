import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ role: 'worker', redis: true, queue: 'ready', postgres: true }));
vi.mock('../../config', () => ({
  config: {
    runtime: {
      get processRole() {
        return state.role;
      },
    },
  },
}));
vi.mock('../../db/postgres', () => ({
  checkPostgresHealth: () => Promise.resolve(state.postgres),
}));
vi.mock('../../utils/redis', () => ({ getRedisStats: () => ({ connected: state.redis }) }));
vi.mock('../../runtime/socketRedisAdapter', () => ({
  isSocketRedisAdapterReady: () => state.redis,
}));
vi.mock('../../queue/connection', () => ({ getQueueConnection: () => ({ status: state.queue }) }));
import { createWorkerHealthApp, runsBackgroundJobs } from '../../runtime/processRole';
import {
  markMigrationsComplete,
  markRuntimeReady,
  markRuntimeShuttingDown,
  resetRuntimeHealthState,
} from '../../utils/runtimeHealth';

describe('split worker health surface', () => {
  beforeEach(() => {
    Object.assign(state, { role: 'worker', redis: true, queue: 'ready', postgres: true });
    resetRuntimeHealthState();
  });
  it('has only health endpoints, with no API or realtime transport', async () => {
    const app = createWorkerHealthApp();
    await request(app).get('/health/live').expect(200);
    await request(app).get('/health/ready').expect(503);
    await request(app).get('/posts').expect(404);
    await request(app).get('/socket.io/?EIO=4&transport=polling').expect(404);
  });
  it('requires schema, database and both Redis transports, then clears readiness while draining', async () => {
    const app = createWorkerHealthApp();
    markMigrationsComplete();
    markRuntimeReady();
    await request(app).get('/health/ready').expect(200);
    state.redis = false;
    await request(app).get('/health/ready').expect(503);
    state.redis = true;
    state.queue = 'reconnecting';
    await request(app).get('/health/ready').expect(503);
    state.queue = 'ready';
    state.postgres = false;
    await request(app).get('/health/ready').expect(503);
    state.postgres = true;
    markRuntimeShuttingDown();
    await request(app).get('/health/ready').expect(503);
    await request(app).get('/health/live').expect(200);
  });
  it('keeps consumers off the dedicated backend and retains them in combined mode', () => {
    expect(runsBackgroundJobs('backend')).toBe(false);
    expect(runsBackgroundJobs('worker')).toBe(true);
    expect(runsBackgroundJobs('combined')).toBe(true);
  });
});
