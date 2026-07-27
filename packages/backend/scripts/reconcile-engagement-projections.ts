/**
 * Post-deploy convergence task for engagement-derived read models.
 *
 * This runs only after the new transactional writers have fully replaced the
 * legacy ECS tasks. It closes the narrow pre-rollout migration window without
 * putting reconciliation into request latency.
 */

import mongoose from 'mongoose';
import { connectToDatabase } from '../src/utils/database';
import { reconcileEngagementProjections } from '../src/services/EngagementProjectionReconciliationService';
import { logger } from '../src/utils/logger';

async function main(): Promise<void> {
  await connectToDatabase();
  await reconcileEngagementProjections();
}

void main()
  .then(async () => {
    await mongoose.disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error('[EngagementProjectionReconciliation] task failed', error);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
