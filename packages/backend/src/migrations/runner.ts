/**
 * Ordered, lease-protected Mongo migrations.
 *
 * Production deploys may briefly run more than one task. A renewable lease
 * prevents two tasks from applying the same schema/data migration concurrently.
 * Individual migrations remain idempotent so a task death before recording
 * completion can be retried safely.
 */

import { randomUUID } from 'crypto';
import { hostname } from 'os';
import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { migrationRepostToBoost } from './0001-repost-to-boost';
import { migrationLowercaseHashtags } from './0002-lowercase-hashtags';
import { migrationTrendingTtlIndex } from './0003-trending-ttl-index';
import { migrationNotificationTtlIndex } from './0004-notification-ttl-index';
import { migrationStarterPackMemberIndex } from './0005-starter-pack-member-index';
import { migrationFederatedStarterPackSourceIndex } from './0006-federated-starter-pack-source-index';
import { migrationFeedGeneratorIndex } from './0007-feed-generator-index';
import { migrationBookmarkStats } from './0008-bookmark-stats';
import { migrationPostRecentRepliers } from './0009-post-recent-repliers';
import { migrationPostHotPathIndexes } from './0010-post-hot-path-indexes';
import { migrationEngagementOutboxIndexes } from './0011-engagement-outbox-indexes';
import { migrationMtnEventIdempotencyIndex } from './0012-mtn-event-idempotency-index';
import { migrationTrendingNameTypeUniqueIndex } from './0013-trending-name-type-unique-index';
import { migrationPostTrendTermsIndex } from './0014-post-trend-terms-index';
import { migrationTrendSummaryIndexes } from './0015-trend-summary-indexes';
import { migrationAdminScriptCursorIndex } from './0016-admin-script-cursor-index';
import { migrationRepairFetchFailureIndexes } from './0017-repair-fetch-failure-indexes';
import { migrationBlockedDomainPurgeIndexes } from './0018-blocked-domain-purge-indexes';
import { migrationBlockedDomainPurgeRunIndexes } from './0019-blocked-domain-purge-run-indexes';
import { migrationBlocklistProposalIndexes } from './0020-blocklist-proposal-indexes';
import { migrationBlocklistProposalRunIndexes } from './0021-blocklist-proposal-run-indexes';
import { migrationLaneIndexes } from './0022-lane-indexes';
import { migrationPostLaneIndex } from './0023-post-lane-index';
import { migrationChannelIndexes } from './0024-channel-indexes';
import { MIGRATIONS_COLLECTION } from './constants';

export interface Migration {
  readonly id: string;
  run(db: mongoose.mongo.Db, context?: MigrationContext): Promise<void>;
}

export interface MigrationContext {
  /** Aborted immediately when the renewable lease can no longer be proven. */
  readonly signal: AbortSignal;
  /** Batch migrations call this between chunks to honor the fencing lease. */
  assertLease(): Promise<void>;
}

interface AppliedMigrationDoc {
  _id: string;
  appliedAt: Date;
}

interface MigrationLeaseDoc {
  _id: string;
  owner: string;
  /** Monotonic fencing token. A stale owner can never renew or complete work. */
  generation: number;
  leaseUntil: Date;
  updatedAt: Date;
}

const MIGRATION_LEASE_COLLECTION = 'migration_leases';
const MIGRATION_LEASE_ID = 'global';
const MIGRATION_LEASE_MS = 30_000;
const MIGRATION_LEASE_RENEW_MS = 10_000;
const MIGRATION_LEASE_WAIT_MS = 60_000;
const MIGRATION_LEASE_POLL_MS = 500;

const MIGRATIONS: readonly Migration[] = [
  migrationRepostToBoost,
  migrationLowercaseHashtags,
  migrationTrendingTtlIndex,
  migrationNotificationTtlIndex,
  migrationStarterPackMemberIndex,
  migrationFederatedStarterPackSourceIndex,
  migrationFeedGeneratorIndex,
  migrationBookmarkStats,
  migrationPostRecentRepliers,
  migrationPostHotPathIndexes,
  migrationEngagementOutboxIndexes,
  migrationMtnEventIdempotencyIndex,
  migrationTrendingNameTypeUniqueIndex,
  migrationPostTrendTermsIndex,
  migrationTrendSummaryIndexes,
  migrationAdminScriptCursorIndex,
  migrationRepairFetchFailureIndexes,
  migrationBlockedDomainPurgeIndexes,
  migrationBlockedDomainPurgeRunIndexes,
  migrationBlocklistProposalIndexes,
  migrationBlocklistProposalRunIndexes,
  migrationLaneIndexes,
  migrationPostLaneIndex,
  migrationChannelIndexes,
];

/**
 * The ordered ids this runner will apply.
 *
 * Exported so that a migration which was WRITTEN but never registered here is a
 * test failure rather than a discovery months later. That mistake is silent by
 * construction: nothing imports the file, nothing runs it, and in production —
 * where `autoIndex`/`autoCreate` are off — the index it was meant to create
 * simply does not exist while every query still works, more slowly or without
 * the constraint it was supposed to enforce.
 */
export const MIGRATION_IDS: readonly string[] = MIGRATIONS.map((migration) => migration.id);

export async function getPendingMigrationIds(): Promise<string[]> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('getPendingMigrationIds: no active mongoose database connection');
  }

  const applied = await db
    .collection<AppliedMigrationDoc>(MIGRATIONS_COLLECTION)
    .find({ _id: { $in: MIGRATIONS.map((migration) => migration.id) } })
    .project<{ _id: string }>({ _id: 1 })
    .toArray();
  const appliedIds = new Set(applied.map((migration) => migration._id));
  return MIGRATIONS
    .map((migration) => migration.id)
    .filter((migrationId) => !appliedIds.has(migrationId));
}

export async function assertMigrationsApplied(): Promise<void> {
  const pending = await getPendingMigrationIds();
  if (pending.length > 0) {
    throw new Error(`Database schema is not current; pending migrations: ${pending.join(', ')}`);
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    Number((error as Error & { code?: number }).code) === 11000
  );
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLease(
  leases: mongoose.mongo.Collection<MigrationLeaseDoc>,
  owner: string,
): Promise<number> {
  const deadline = Date.now() + MIGRATION_LEASE_WAIT_MS;
  while (Date.now() < deadline) {
    const now = new Date();
    try {
      const lease = await leases.findOneAndUpdate(
        {
          _id: MIGRATION_LEASE_ID,
          $or: [{ owner }, { leaseUntil: { $lte: now } }],
        },
        {
          $set: {
            owner,
            leaseUntil: new Date(now.getTime() + MIGRATION_LEASE_MS),
            updatedAt: now,
          },
          $inc: { generation: 1 },
        },
        { upsert: true, returnDocument: 'after' },
      );
      if (
        lease?.owner === owner &&
        Number.isSafeInteger(lease.generation) &&
        lease.generation > 0
      ) {
        return lease.generation;
      }
    } catch (error) {
      // Competing upserts can race on the fixed _id. The loser waits for the
      // current lease holder and then observes the applied migration records.
      if (!isDuplicateKey(error)) throw error;
    }
    await wait(MIGRATION_LEASE_POLL_MS);
  }
  throw new Error('Timed out waiting for the global migration lease');
}

async function assertLeaseOwned(
  leases: mongoose.mongo.Collection<MigrationLeaseDoc>,
  owner: string,
  generation: number,
): Promise<void> {
  const lease = await leases.findOne(
    {
      _id: MIGRATION_LEASE_ID,
      owner,
      generation,
      leaseUntil: { $gt: new Date() },
    },
    { projection: { _id: 1 } },
  );
  if (!lease) {
    throw new Error(
      `Migration lease fence was lost (owner=${owner}, generation=${generation})`,
    );
  }
}

export async function runMigrations(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('runMigrations: no active mongoose database connection');
  }

  const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
  const leases = db.collection<MigrationLeaseDoc>(MIGRATION_LEASE_COLLECTION);
  const generation = await acquireLease(leases, owner);

  let leaseLost = false;
  const leaseAbort = new AbortController();
  let rejectLeaseLoss!: (error: Error) => void;
  const leaseLoss = new Promise<never>((_resolve, reject) => {
    rejectLeaseLoss = reject;
  });
  // The race below observes this rejection during a migration. This catch also
  // covers the narrow interval before the first migration begins.
  void leaseLoss.catch(() => undefined);
  const markLeaseLost = (error: Error): void => {
    if (leaseLost) return;
    leaseLost = true;
    leaseAbort.abort(error);
    rejectLeaseLoss(error);
  };
  let renewalInFlight: Promise<void> | null = null;
  const renewal = setInterval(() => {
    if (renewalInFlight || leaseLost) return;
    const now = new Date();
    renewalInFlight = leases
      .updateOne(
        { _id: MIGRATION_LEASE_ID, owner, generation },
        {
          $set: {
            leaseUntil: new Date(now.getTime() + MIGRATION_LEASE_MS),
            updatedAt: now,
          },
        },
      )
      .then((result) => {
        if (result.matchedCount !== 1) {
          markLeaseLost(
            new Error(
              `Migration lease renewal lost its fence (generation=${generation})`,
            ),
          );
        }
      })
      .catch((error) => {
        markLeaseLost(
          error instanceof Error
            ? error
            : new Error(`Migration lease renewal failed: ${String(error)}`),
        );
        logger.error('[migration] lease renewal failed', error);
      })
      .finally(() => {
        renewalInFlight = null;
      });
  }, MIGRATION_LEASE_RENEW_MS);
  renewal.unref?.();

  try {
    const migrations = db.collection<AppliedMigrationDoc>(MIGRATIONS_COLLECTION);
    const assertLease = async (): Promise<void> => {
      if (leaseLost) {
        throw new Error('Migration lease was lost while applying schema changes');
      }
      try {
        await assertLeaseOwned(leases, owner, generation);
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        markLeaseLost(normalized);
        throw normalized;
      }
    };
    const migrationContext: MigrationContext = {
      signal: leaseAbort.signal,
      assertLease,
    };

    for (const migration of MIGRATIONS) {
      await assertLease();

      const existing = await migrations.findOne({ _id: migration.id });
      if (existing) {
        logger.info('[migration] already applied; skipping');
        continue;
      }

      logger.info('[migration] applying');
      const migrationRun = migration.run(db, migrationContext);
      try {
        await Promise.race([
          migrationRun,
          leaseLoss,
        ]);
      } catch (error) {
        // Promise.race does not cancel the losing Mongo operation. Abort
        // cooperative migrations and then wait for the original run to settle
        // before this process can release its lease or close its clients. If a
        // migration ignores AbortSignal, the ECS one-shot remains occupied and
        // the deployment timeout stops the whole task instead of allowing
        // background schema writes to outlive the lease owner.
        if (!leaseAbort.signal.aborted) leaseAbort.abort(error);
        await migrationRun.catch((settleError) => {
          if (settleError !== error) {
            logger.warn(
              '[migration] settled with a second error after abort',
              settleError,
            );
          }
        });
        logger.error('[migration] failed', error);
        throw error;
      }

      await assertLease();
      await migrations.insertOne({ _id: migration.id, appliedAt: new Date() });
      logger.info('[migration] applied');
    }
  } finally {
    clearInterval(renewal);
    await Promise.resolve(renewalInFlight).catch(() => undefined);
    await leases.deleteOne({
      _id: MIGRATION_LEASE_ID,
      owner,
      generation,
    }).catch((error) => {
      logger.warn('[migration] failed to release lease', error);
    });
  }
}
