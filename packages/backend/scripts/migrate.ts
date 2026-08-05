/**
 * Production migration entrypoint.
 *
 * This process owns schema/data changes. Web tasks only verify that the schema
 * version is current before becoming ready. The migration runner itself holds a
 * renewable Mongo lease, so concurrent deployment tasks cannot apply the same
 * migration twice.
 */

import mongoose from 'mongoose';
import { logger } from '../src/utils/logger';
import { closePostgres, connectPostgres } from '../src/db/postgres';
import { runMigrationTask } from '../src/migrations/task';

/**
 * BOTH stores, and Postgres is not optional here despite this being the MONGO
 * migration one-shot.
 *
 * A one-shot entry point gets none of `server.ts`'s startup, so whatever it
 * reaches must be opened here. `runMigrationTask`'s own docblock says the only
 * live payload left is `reconcileBlockedDomains` and that it "is Postgres-only"
 * — and that payload runs `purgeBlockedDomainContent`, whose own
 * `connectPostgres` lives inside a `require.main === module` block and therefore
 * does NOT run for an importer. Without this the first `getDb()` throws
 * `PostgreSQL is not connected`, which `reconcileBlockedDomains` catches and
 * logs as fail-soft — so blocking a domain silently stops purging its content
 * while the deploy reports success.
 *
 * Nothing went red when the purge was ported (2026-08-02, `cd122151`) because
 * the link between an entry point and the store its callee reads is a RUNTIME
 * CONNECTION, not a symbol: `tsc` cannot see it and no test runs this file.
 */
async function main(): Promise<void> {
  await connectPostgres();
  await runMigrationTask();
}

void main()
  .then(async () => {
    await Promise.all([mongoose.disconnect(), closePostgres()]);
    logger.info('[migration] all migrations are current');
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error('[migration] migration task failed', error);
    // Both, and both tolerant: a failure BEFORE either connect must still reach
    // `process.exit(1)` rather than dying in its own cleanup. `closePostgres`
    // is already a no-op when the pool was never opened.
    await Promise.all([
      mongoose.disconnect().catch(() => undefined),
      closePostgres().catch(() => undefined),
    ]);
    process.exit(1);
  });
