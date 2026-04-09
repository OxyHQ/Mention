import request from 'supertest';
import express from 'express';

// Use the exported app setup by importing the server entry
// We wrap the routes to avoid starting the HTTP server in tests.
import healthRoutes from '../routes/health.routes';

describe('health routes', () => {
  const app = express();
  app.use(healthRoutes);

  it('responds 200 on /health', async () => {
    await request(app).get('/health').expect(200);
  });

  it('responds 200 on /ready', async () => {
    await request(app).get('/ready').expect(200);
  });
});
