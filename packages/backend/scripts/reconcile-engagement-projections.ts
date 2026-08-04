/**
 * Post-deploy convergence task for engagement-derived read models.
 *
 * This runs only after the new transactional writers have fully replaced the
 * legacy ECS tasks. It closes the narrow pre-rollout migration window without
 * putting reconciliation into request latency.
 *
 * Postgres-only, because `reconcileEngagementProjections` reads and writes
 * exclusively through Drizzle. A one-shot gets none of `server.ts`'s startup,
 * so it must open the pool itself: without `connectPostgres()` the service's
 * first `getDb()` throws `PostgreSQL is not connected`, this task exits 1, and
 * `deploy-aws.yml` rolls the whole service back on every deploy.
 */

import { closePostgres, connectPostgres } from '../src/db/postgres';
import { reconcileEngagementProjections } from '../src/services/EngagementProjectionReconciliationService';
import { logger } from '../src/utils/logger';

async function main(): Promise<void> {
  await connectPostgres();
  await reconcileEngagementProjections();
}

void main()
  .then(async () => {
    await closePostgres();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error('[EngagementProjectionReconciliation] task failed', error);
    await closePostgres().catch(() => undefined);
    process.exit(1);
  });
