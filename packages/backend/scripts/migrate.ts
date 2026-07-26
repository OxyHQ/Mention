/**
 * Production migration entrypoint.
 *
 * This process owns schema/data changes. Web tasks only verify that the schema
 * version is current before becoming ready. The migration runner itself holds a
 * renewable Mongo lease, so concurrent deployment tasks cannot apply the same
 * migration twice.
 */

import mongoose from 'mongoose';
import { connectToDatabase } from '../src/utils/database';
import { logger } from '../src/utils/logger';
import { runMigrations } from '../src/migrations/runner';

async function main(): Promise<void> {
  await connectToDatabase();
  await runMigrations();
}

void main()
  .then(async () => {
    await mongoose.disconnect();
    logger.info('[migration] all migrations are current');
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error('[migration] migration task failed', error);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
