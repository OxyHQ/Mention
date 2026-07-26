import {
  connectToDatabase,
  type DatabaseConnectionOptions,
} from '../utils/database';
import { runMigrations } from './runner';

/**
 * Index builds and bounded backfills legitimately outlive the web runtime's
 * 45-second socket timeout. Keep the override local to the ECS one-shot and
 * below the deploy helper's 20-minute task deadline. Canonical branch selection
 * must read the primary, never a lagging secondary.
 */
export const MIGRATION_DATABASE_CONNECTION_OPTIONS = Object.freeze({
  socketTimeoutMS: 15 * 60 * 1_000,
  minPoolSize: 0,
  maxPoolSize: 10,
  readPreference: 'primary',
}) satisfies DatabaseConnectionOptions;

export async function runMigrationTask(): Promise<void> {
  await connectToDatabase(MIGRATION_DATABASE_CONNECTION_OPTIONS);
  await runMigrations();
}
