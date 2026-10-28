import http from 'node:http';
import type { Socket } from 'socket.io';
import {
  createWorkerHealthApp,
  createWorkerSocketEmitter,
  assertQueueReady,
  runsBackgroundJobs,
} from './src/runtime/processRole';
import { startBackgroundJobs } from './src/runtime/backgroundJobs';
import { getRuntimeOxyClient } from './src/runtime/oxyClient';
import { initConnectors } from './src/connectors';
import { startPlatformActivity } from './src/runtime/platformActivity';
import { getRuntimeHealthState } from './src/utils/runtimeHealth';
import { hostname } from 'node:os';
import { config, validateEnvironment } from './src/config';
import { connectServingPostgres, getPostgresClient } from './src/db/postgres';
import { assertPostgresMigrationsCurrent } from './src/db/migrationsFolder';
import { registerAllModules } from './src/mtn/feed/engine';
import { registerGlobalErrorHandlers } from './src/runtime/globalErrorHandlers';
import { registerGracefulShutdown } from './src/runtime/gracefulShutdown';
import { PresenceRegistry } from './src/runtime/presenceRegistry';
import { createSocketIoServer, createSocketNamespaces } from './src/runtime/socketIoServer';
import { registerSocketHandlers } from './src/runtime/socketHandlers';
import { attachSocketRedisAdapter } from './src/runtime/socketRedisAdapter';
import { setRuntimeSocketServer } from './src/runtime/socketServer';
import { DistributedPresenceService } from './src/services/DistributedPresenceService';
import { presenceRoom } from '@mention/shared-types';
import {
  startUserInvalidationSubscriber,
  type UserInvalidationSubscriber,
} from './src/services/userInvalidationSubscriber';
import { logger } from './src/utils/logger';
import { getRedisClient } from './src/utils/redis';
import {
  markMigrationsComplete,
  markRuntimeNotReady,
  markRuntimeReady,
} from './src/utils/runtimeHealth';

// Registered before bootstrap starts any asynchronous work; the imports above
// have finished, so the sanitizer and validated config are live in a handler.
registerGlobalErrorHandlers();

const activity = startPlatformActivity(() => getRuntimeHealthState().phase === 'ready');
const isWorker = config.runtime.processRole === 'worker';
const splitProcess = config.runtime.processRole !== 'combined';
if (isWorker) initConnectors();
export const { app, oxy } = isWorker
  ? { app: createWorkerHealthApp(), oxy: getRuntimeOxyClient() }
  : createHttpRuntime();

/** Do not load product route trees or their caches into a dedicated worker. */
function createHttpRuntime() {
  const { createRuntimeApp }: typeof import('./src/runtimeApp') = require('./src/runtimeApp');
  return createRuntimeApp(activity?.observeHttp);
}

// --- Sockets ---
const server = http.createServer(app);
// A Socket.IO server on a non-listening HTTP server is an emitter only. Its Redis adapter reaches
// the backend fleet; the worker health listener exposes no socket transport.
const io = isWorker ? createWorkerSocketEmitter() : createSocketIoServer(server);
setRuntimeSocketServer(io);

const presence = new PresenceRegistry({
  distributedPresence: new DistributedPresenceService(
    getRedisClient,
    `${hostname()}:${process.pid}`,
  ),
  isSocketConnected: (socketId) => io.sockets.sockets.get(socketId)?.connected === true,
  // Emit to users subscribed to this user's presence. Targeted emit only — no
  // global broadcast.
  emitPresence: (userId, payload) => {
    io.to(presenceRoom(userId)).emit('user:presence', payload);
  },
});
if (!isWorker) presence.startHousekeeping();

const namespaces = createSocketNamespaces(io, oxy);
for (const namespace of [io.of('/'), ...Object.values(namespaces)]) {
  namespace.on('connection', (socket: Socket) => activity?.observeSocket(socket));
}
if (!isWorker) registerSocketHandlers(io, namespaces, presence);
const notificationsNamespace = namespaces.notificationsNamespace;

// --- Expose namespaces for use in routes ---
app.set('io', io);
app.set('notificationsNamespace', notificationsNamespace);
app.set('postsNamespace', namespaces.postsNamespace);

// --- Server Listen ---
const PORT = config.runtime.port;
let userInvalidationSubscriber: UserInvalidationSubscriber | null = null;

const bootServer = async () => {
  validateEnvironment();
  markRuntimeNotReady('booting');
  // ONE store opens here, and it is Postgres. `getDb()` throws until this
  // resolves, so a task that skipped it would answer the health check and then
  // fail every query.
  await connectServingPostgres();

  // Production migrations run as a deployment one-shot with the exact image
  // that will be rolled out. Web tasks never mutate schema during a scale-out;
  // they only refuse readiness until that one-shot has completed.
  //
  // This assert is load-bearing rather than defence in depth: the drizzle
  // migrations are applied by the deploy's one-shot, and a task that boots
  // against a database that one-shot never reached becomes ready and then
  // fails every Postgres query — after traffic has been routed to it. Outside
  // production the migrator is a developer command (`bun run db:migrate`), so
  // there is nothing here to assert against.
  if (config.runtime.isProduction) {
    await assertPostgresMigrationsCurrent(getPostgresClient());
  }
  markMigrationsComplete();

  // Setup Redis adapter before accepting connections to ensure
  // cross-instance broadcasts work from the first connection
  await attachSocketRedisAdapter(io, splitProcess);
  if (splitProcess) await assertQueueReady();

  // Drop cached Oxy identity as soon as Oxy says it changed, instead of waiting
  // out the user-summary TTL. Runs on EVERY task: the SDK response caches it
  // sweeps are per-process, so a leader-only subscriber would leave the rest of
  // the fleet stale. Inert (and non-fatal) when Redis is unavailable.
  userInvalidationSubscriber = await startUserInvalidationSubscriber();

  registerAllModules();
  if (runsBackgroundJobs(config.runtime.processRole)) {
    await startBackgroundJobs(splitProcess);
  }

  // Start server after all async setup is complete
  server.listen(PORT, '0.0.0.0', () => {
    markRuntimeReady();
    logger.info(`Server running at http://localhost:${PORT}`);
  });
};

registerGracefulShutdown({
  stopActivity: () => activity?.stop() ?? Promise.resolve(),
  server,
  io,
  presence,
  stopUserInvalidationSubscriber: async () => {
    if (!userInvalidationSubscriber) return;
    const handle = userInvalidationSubscriber;
    userInvalidationSubscriber = null;
    await handle.stop();
  },
});

if (require.main === module) {
  void bootServer().catch((error) => {
    markRuntimeNotReady('boot_failed');
    logger.error('Backend boot failed', error);
    process.exit(1);
  });
}

export { io, notificationsNamespace };
export default server;
