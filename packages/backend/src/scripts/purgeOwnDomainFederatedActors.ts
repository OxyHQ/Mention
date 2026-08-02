/**
 * One-shot cleanup: delete `FederatedActor` rows that were mistakenly created
 * for our OWN users.
 *
 * Oxy's identity apex (`oxy.so`, the DID layer's anchor) publishes every
 * Oxy/Mention user as `acct:<username>@<apex>`. Before the federation guard was
 * widened (see `connectors/activitypub/constants.ts` → `isBlockedDomain` +
 * `OXY_IDENTITY_APEX`), `ActorService.fetchRemoteActor` treated that apex as a
 * remote source and upserted a `FederatedActor` (plus an Oxy
 * `PUT /users/resolve`) for actors there — duplicating local users as
 * "federated" accounts. The guard now lives in
 * `connectors/activitypub/constants.ts` (`isBlockedDomain` + `OXY_IDENTITY_APEX`).
 *
 * This script removes those stale rows. A row is targeted when its stored
 * `domain` OR its `uri` host is caught by the SAME `isBlockedDomain` predicate
 * the live guard now uses (so there is one source of truth — no parallel
 * domain list). Legit remote actors (mastodon.social, threads.net, …) are never
 * matched.
 *
 * It is idempotent and re-runnable (after a clean run nothing matches) and pages
 * by a stable ascending `id` cursor. Before deleting each row, a fail-closed
 * preflight proves there are no known Mention references by actor URI or linked
 * Oxy user id. Referenced rows are never deleted.
 *
 * Supports `DRY_RUN=1` (or `true`) to report what WOULD be deleted without
 * mutating anything.
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   DRY_RUN=1 node dist/scripts/purgeOwnDomainFederatedActors.js   # preview
 *   CONFIRM_ADMIN_MUTATION=purgeOwnDomainFederatedActors \
 *     node dist/scripts/purgeOwnDomainFederatedActors.js           # reviewed delete
 */

import mongoose from 'mongoose';
import { deleteActorsByUris, scanActors } from '../db/federation/actorRepository';
import { connectPostgres, closePostgres } from '../db/postgres';
import { connectToDatabase } from '../utils/database';
import { isBlockedDomain } from '../connectors/activitypub/constants';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { assertActorSafeToDelete } from './lib/adminDeletionPreflight';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';

/** Actors scanned per page (stable `id` cursor pagination). */
const PAGE_SIZE = 500;

/** Deletes flushed per `deleteMany` chunk. */
const DELETE_CHUNK_SIZE = 500;

const DRY_RUN = ['1', 'true', 'yes'].includes((process.env.DRY_RUN || '').trim().toLowerCase());

interface FederatedActorRow {
  id: string;
  uri: string;
  acct: string;
  domain: string;
  oxyUserId?: string;
}

/** Hostname of a stored actor URI, lowercased; null when the URI is malformed. */
function hostOf(uri: string): string | null {
  try {
    return new URL(uri).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * A row belongs to an own/blocked domain when EITHER its denormalized `domain`
 * field OR its canonical `uri` host is rejected by the live federation guard.
 */
function isOwnDomainActor(row: FederatedActorRow): boolean {
  if (row.domain && isBlockedDomain(row.domain.toLowerCase())) return true;
  const host = hostOf(row.uri);
  return host !== null && isBlockedDomain(host);
}

async function purgeOwnDomainFederatedActors(): Promise<void> {
  const startedAt = Date.now();

  try {
    assertAdminMutationAllowed({
      scriptName: 'purgeOwnDomainFederatedActors',
      dryRun: DRY_RUN,
    });
    await connectToDatabase();
    // Actor rows are in Postgres; the deletion preflight still probes Mongo.
    await connectPostgres();
    logger.info(
      `[purgeOwnDomainFederatedActors] connected${DRY_RUN ? ' — DRY_RUN (no writes)' : ''}`,
    );

    let scanned = 0;
    let matched = 0;
    let deleted = 0;
    let lastId: string | undefined;
    // Batched by URI rather than by primary key: `uri` is what the operator sees
    // in the report and what the preflight authorized, and it is unique, so the
    // delete addresses exactly the rows that were checked.
    let pendingUris: string[] = [];

    const flush = async (): Promise<void> => {
      if (pendingUris.length === 0) return;
      if (!DRY_RUN) {
        deleted += await deleteActorsByUris(pendingUris);
      }
      pendingUris = [];
    };

    for (;;) {
      const page: FederatedActorRow[] = await scanActors({}, { afterId: lastId, limit: PAGE_SIZE });

      if (page.length === 0) break;

      for (const row of page) {
        if (isOwnDomainActor(row)) {
          matched += 1;
          await assertActorSafeToDelete(
            `purgeOwnDomainFederatedActors:${row.acct}`,
            { oxyUserId: row.oxyUserId, actorUri: row.uri },
          );
          pendingUris.push(row.uri);
    logger.info('[purgeOwnDomainFederatedActors] matched actor processed', {
      dryRun: DRY_RUN,
    });
          if (pendingUris.length >= DELETE_CHUNK_SIZE) {
            await flush();
          }
        }
      }

      scanned += page.length;
      lastId = page[page.length - 1].id;
    }

    await flush();

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[purgeOwnDomainFederatedActors] done${DRY_RUN ? ' (DRY_RUN)' : ''}: scanned ${scanned}, matched ${matched}, deleted ${DRY_RUN ? 0 : deleted} (${elapsedSeconds}s)`,
    );

    assertAdminRunComplete('purgeOwnDomainFederatedActors', {
      deleteMismatch: DRY_RUN ? 0 : Math.max(0, matched - deleted),
    });
  } catch (error) {
    logger.error('[purgeOwnDomainFederatedActors] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
    await mongoose.disconnect();
    await closePostgres();
  }
}

if (require.main === module) {
  purgeOwnDomainFederatedActors()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[purgeOwnDomainFederatedActors] unhandled failure', error);
      process.exit(1);
    });
}

export default purgeOwnDomainFederatedActors;
