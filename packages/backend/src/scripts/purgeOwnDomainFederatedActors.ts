/**
 * One-shot cleanup: delete `FederatedActor` rows that were mistakenly created
 * for our OWN users.
 *
 * Oxy's identity apex (`oxy.so`, the DID layer's anchor) publishes every
 * Oxy/Mention user as `acct:<username>@<apex>`. Before the federation guard was
 * widened (see `utils/federation/constants.ts` → `isBlockedDomain` +
 * `OXY_IDENTITY_APEX`), `ActorService.fetchRemoteActor` treated that apex as a
 * remote source and upserted a `FederatedActor` (plus an Oxy
 * `PUT /users/resolve`) for actors there — duplicating local users as
 * "federated" accounts.
 *
 * This script removes those stale rows. A row is targeted when its stored
 * `domain` OR its `uri` host is caught by the SAME `isBlockedDomain` predicate
 * the live guard now uses (so there is one source of truth — no parallel
 * domain list). Legit remote actors (mastodon.social, threads.net, …) are never
 * matched.
 *
 * It is idempotent and re-runnable (after a clean run nothing matches), pages by
 * a stable ascending `_id` cursor, and prints a scanned/deleted summary plus any
 * `FederatedFollow` rows that still point at a deleted actor URI (those follow
 * relationships reference our own users and likely need manual care — this
 * script does NOT touch them).
 *
 * Supports `DRY_RUN=1` (or `true`) to report what WOULD be deleted without
 * mutating anything.
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   DRY_RUN=1 node dist/scripts/purgeOwnDomainFederatedActors.js   # preview
 *   node dist/scripts/purgeOwnDomainFederatedActors.js             # delete
 */

import mongoose from 'mongoose';
import FederatedActor from '../models/FederatedActor';
import FederatedFollow from '../models/FederatedFollow';
import { isBlockedDomain } from '../utils/federation/constants';
import { logger } from '../utils/logger';

/** Actors scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Deletes flushed per `deleteMany` chunk. */
const DELETE_CHUNK_SIZE = 500;

/** Sample of orphaned-follow URIs to print in the summary. */
const REFERENCED_SAMPLE_LIMIT = 25;

const DRY_RUN = (() => {
  const raw = (process.env.DRY_RUN || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
})();

interface FederatedActorRow {
  _id: mongoose.Types.ObjectId;
  uri: string;
  acct: string;
  domain: string;
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
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(
      `[purgeOwnDomainFederatedActors] connected to MongoDB (${dbName})${DRY_RUN ? ' — DRY_RUN (no writes)' : ''}`,
    );

    let scanned = 0;
    let matched = 0;
    let deleted = 0;
    let lastId: mongoose.Types.ObjectId | null = null;
    let pendingIds: mongoose.Types.ObjectId[] = [];
    const deletedUris: string[] = [];

    const flush = async (): Promise<void> => {
      if (pendingIds.length === 0) return;
      if (!DRY_RUN) {
        const result = await FederatedActor.deleteMany({ _id: { $in: pendingIds } });
        deleted += result.deletedCount ?? 0;
      }
      pendingIds = [];
    };

    for (;;) {
      const pageFilter: Record<string, unknown> = {};
      if (lastId) pageFilter._id = { $gt: lastId };

      const page = await FederatedActor.find(pageFilter, { _id: 1, uri: 1, acct: 1, domain: 1 })
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean<FederatedActorRow[]>();

      if (page.length === 0) break;

      for (const row of page) {
        if (isOwnDomainActor(row)) {
          matched += 1;
          deletedUris.push(row.uri);
          pendingIds.push(row._id);
          logger.info(
            `[purgeOwnDomainFederatedActors] ${DRY_RUN ? 'would delete' : 'deleting'} actor acct=${row.acct} domain=${row.domain} uri=${row.uri}`,
          );
          if (pendingIds.length >= DELETE_CHUNK_SIZE) {
            await flush();
          }
        }
      }

      scanned += page.length;
      lastId = page[page.length - 1]._id;
    }

    await flush();

    // Report follow relationships that still reference a removed actor URI.
    // These point at our own users and likely need manual care; this script
    // intentionally does not delete them.
    let referencedFollows = 0;
    if (deletedUris.length > 0) {
      referencedFollows = await FederatedFollow.countDocuments({ remoteActorUri: { $in: deletedUris } });
      if (referencedFollows > 0) {
        const sample = await FederatedFollow.find(
          { remoteActorUri: { $in: deletedUris } },
          { remoteActorUri: 1, localUserId: 1, direction: 1, status: 1 },
        )
          .limit(REFERENCED_SAMPLE_LIMIT)
          .lean();
        logger.warn(
          `[purgeOwnDomainFederatedActors] ${referencedFollows} FederatedFollow row(s) still reference a removed actor URI — review manually (not deleted by this script)`,
        );
        for (const follow of sample) {
          logger.warn(
            `[purgeOwnDomainFederatedActors]   follow localUserId=${follow.localUserId} ${follow.direction}/${follow.status} → ${follow.remoteActorUri}`,
          );
        }
      }
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[purgeOwnDomainFederatedActors] done${DRY_RUN ? ' (DRY_RUN)' : ''}: scanned ${scanned}, matched ${matched}, deleted ${DRY_RUN ? 0 : deleted}, referencing follows ${referencedFollows} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[purgeOwnDomainFederatedActors] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  purgeOwnDomainFederatedActors();
}

export default purgeOwnDomainFederatedActors;
