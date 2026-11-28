import http from 'node:http';
import { Server } from 'socket.io';
import express from 'express';
import healthRoutes from '../routes/health.routes';
import { getQueueConnection } from '../queue/connection';

export type ProcessRole = 'combined' | 'backend' | 'worker';
export function runsBackgroundJobs(role: ProcessRole): boolean {
  return role !== 'backend';
}

/** No product routes or Socket.IO transport on a dedicated worker. */
export function createWorkerHealthApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(healthRoutes);
  return app;
}

/** Bound startup even though BullMQ deliberately retries Redis indefinitely. */
export async function assertQueueReady(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      getQueueConnection().ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Worker queue Redis startup timed out')), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Socket.IO requires an attached engine to close cleanly. This server never listens. */
export function createWorkerSocketEmitter(): Server {
  return new Server(http.createServer());
}
