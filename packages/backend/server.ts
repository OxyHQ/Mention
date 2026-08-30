import http from "http";
import { hostname } from 'os';
import { config, validateEnvironment } from './src/config';
import { connectPostgres, getPostgresClient } from "./src/db/postgres";
import { assertPostgresMigrationsCurrent } from "./src/db/migrationsFolder";
import { registerAllModules } from './src/mtn/feed/engine';
import { startWorkers } from './src/queue/workers';
import { registerGlobalErrorHandlers } from './src/runtime/globalErrorHandlers';
import { registerGracefulShutdown } from './src/runtime/gracefulShutdown';
import { PresenceRegistry } from './src/runtime/presenceRegistry';
import { startSchedulers, stopSchedulers } from './src/runtime/schedulers';
import { createSocketIoServer, createSocketNamespaces } from './src/runtime/socketIoServer';
import { registerSocketHandlers } from './src/runtime/socketHandlers';
import { attachSocketRedisAdapter } from './src/runtime/socketRedisAdapter';
import { setRuntimeSocketServer } from './src/runtime/socketServer';
import { createRuntimeApp } from './src/runtimeApp';
import { DistributedPresenceService } from './src/services/DistributedPresenceService';
import { engagementOutboxDispatcher } from './src/services/EngagementOutboxDispatcher';
import { leaderElection } from "./src/services/LeaderElection";
import { moderationOutboxDispatcher } from './src/services/moderation/ModerationOutboxDispatcher';
import {
  startUserInvalidationSubscriber,
  type UserInvalidationSubscriber,
} from './src/services/userInvalidationSubscriber';
import { logger } from "./src/utils/logger";
import { getRedisClient } from './src/utils/redis';
import {
  markMigrationsComplete,
  markRuntimeNotReady,
  markRuntimeReady,
} from './src/utils/runtimeHealth';

// Registered before bootstrap starts any asynchronous work; the imports above
// have finished, so the sanitizer and validated config are live in a handler.
registerGlobalErrorHandlers();

export const { app, oxy } = createRuntimeApp();

// --- Sockets ---
const server = http.createServer(app);
const io = createSocketIoServer(server);
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
    io.to(`presence:${userId}`).emit('user:presence', payload);
  },
});
presence.startHousekeeping();

const namespaces = createSocketNamespaces(io, oxy);
registerSocketHandlers(io, namespaces, presence);
const notificationsNamespace = namespaces.notificationsNamespace;

// --- Expose namespaces for use in routes ---
app.set("io", io);
app.set("notificationsNamespace", notificationsNamespace);
app.set("postsNamespace", namespaces.postsNamespace);

// --- Server Listen ---
const PORT = config.runtime.port;
let userInvalidationSubscriber: UserInvalidationSubscriber | null = null;

const bootServer = async () => {
  validateEnvironment();
  markRuntimeNotReady('booting');
  // ONE store opens here, and it is Postgres. `getDb()` throws until this
  // resolves, so a task that skipped it would answer the health check and then
  // fail every query.
  //
  // Mongo used to open FIRST, on this line, on every task — so a web task could
  // not boot without it even though no runtime read or write had gone to Mongo
  // since the cutover. That connection went first, and the rest of the surface
  // (driver, models, the Mongo→Postgres copier) followed: there is no Mongo
  // left in this package for any entry point to open.
  await connectPostgres();

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
  await attachSocketRedisAdapter(io);

  // Drop cached Oxy identity as soon as Oxy says it changed, instead of waiting
  // out the user-summary TTL. Runs on EVERY task: the SDK response caches it
  // sweeps are per-process, so a leader-only subscriber would leave the rest of
  // the fleet stale. Inert (and non-fatal) when Redis is unavailable.
  userInvalidationSubscriber = await startUserInvalidationSubscriber();

  // Start BullMQ federation queue workers on EVERY task (inbox + delivery
  // throughput should scale with the fleet; BullMQ delivers each job to exactly
  // one worker). No-op when Redis is not configured — federation then falls
  // back to inline inbox processing + the in-process delivery scheduler, which
  // drains the Postgres `federation_delivery_queue` table.
  // Periodic repeatable-job REGISTRATION is leader-only (FederationJobScheduler,
  // driven by leaderElection); only the consuming workers run everywhere.
  try {
    startWorkers();
  } catch (error) {
    logger.warn("Failed to start federation queue workers", error);
  }

  // Register MTN Protocol feed engine modules (sources / signals / filters)
  registerAllModules();

  // Lease-claimed workers may run on every task: the claim is an atomic Postgres
  // update and does not depend on Redis leadership, so committed engagement
  // effects keep draining even while Redis is degraded.
  engagementOutboxDispatcher.start();
  // Same reasoning for moderation: a report and its delivery event committed
  // together, and the lease-based claim means every task can drain the queue.
  // No-ops when CROWDSOURCE_ENABLED=false, leaving the durable rows for later.
  moderationOutboxDispatcher.start();

  // Singleton jobs start only after the schema is ready. Leader election fails
  // closed when Redis is unavailable, while the HTTP API can remain degraded.
  await leaderElection.start(startSchedulers, stopSchedulers);

  // Start server after all async setup is complete
  server.listen(PORT, '0.0.0.0', () => {
    markRuntimeReady();
    logger.info(`Server running at http://localhost:${PORT}`);
  });
};

registerGracefulShutdown({
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
