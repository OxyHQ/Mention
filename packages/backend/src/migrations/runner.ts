/**
 * Migration runner.
 *
 * Runs all registered migrations once, in order, recording applied ids in the
 * `migrations` collection. Designed to be awaited at backend boot, after the
 * database connection is established and before the HTTP server starts
 * listening, so the process never serves traffic against half-migrated data.
 *
 * Failures are logged with context and rethrown — boot must fail loudly rather
 * than continue on partially migrated data.
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { MIGRATIONS_COLLECTION } from './constants';
import { migrationRepostToBoost } from './0001-repost-to-boost';
import { migrationLowercaseHashtags } from './0002-lowercase-hashtags';
import { migrationTrendingTtlIndex } from './0003-trending-ttl-index';
import { migrationNotificationTtlIndex } from './0004-notification-ttl-index';
import { migrationStarterPackMemberIndex } from './0005-starter-pack-member-index';
import { migrationFederatedStarterPackSourceIndex } from './0006-federated-starter-pack-source-index';

export interface Migration {
  /** Stable, unique migration id recorded in the migrations collection. */
  readonly id: string;
  /** Perform the migration. Must be safe to skip if already applied. */
  run(db: mongoose.mongo.Db): Promise<void>;
}

interface AppliedMigrationDoc {
  _id: string;
  appliedAt: Date;
}

/** Ordered list of migrations to run at boot. */
const MIGRATIONS: readonly Migration[] = [
  migrationRepostToBoost,
  migrationLowercaseHashtags,
  migrationTrendingTtlIndex,
  migrationNotificationTtlIndex,
  migrationStarterPackMemberIndex,
  migrationFederatedStarterPackSourceIndex,
];

/**
 * Run all pending migrations. Idempotent: previously applied migrations are
 * skipped based on records in the migrations collection.
 *
 * @throws if any migration fails — callers should let this propagate so boot
 *   aborts rather than running on partially migrated data.
 */
export async function runMigrations(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('runMigrations: no active mongoose database connection');
  }

  const migrationsCollection = db.collection<AppliedMigrationDoc>(MIGRATIONS_COLLECTION);

  for (const migration of MIGRATIONS) {
    const existing = await migrationsCollection.findOne({ _id: migration.id });
    if (existing) {
      logger.info(`[migration] ${migration.id} already applied — skipping`);
      continue;
    }

    logger.info(`[migration] ${migration.id} applying...`);
    try {
      await migration.run(db);
    } catch (error) {
      logger.error(`[migration] ${migration.id} failed`, error);
      throw error;
    }

    await migrationsCollection.insertOne({ _id: migration.id, appliedAt: new Date() });
    logger.info(`[migration] ${migration.id} applied`);
  }
}
