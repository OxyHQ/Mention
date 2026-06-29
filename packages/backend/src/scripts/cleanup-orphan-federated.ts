/**
 * One-shot legacy cleanup: eliminate ORPHAN federated posts — federated Posts
 * that were stored with no `oxyUserId` (a null/absent Oxy author).
 *
 * Background: federated posts used to be inserted with `oxyUserId: actor.oxyUserId
 * ?? null` when actor→Oxy resolution failed silently, producing posts with no
 * real author. Stage 1 (B1) makes the Oxy link MANDATORY at ingest, so NO new
 * orphans are created. This script cleans up the pre-existing ones so the
 * invariant "every federated post has an `oxyUserId`" holds across the whole
 * collection.
 *
 * Per distinct `federation.actorUri` of the orphan posts:
 *   - RESOLVE the actor (reuse the stored `FederatedActor.oxyUserId` when already
 *     set, otherwise re-fetch via `ActorService.fetchRemoteActor`, which runs
 *     Oxy's `PUT /users/resolve` and stamps `oxyUserId` on the actor). If it
 *     resolves → `$set oxyUserId` on every orphan post of that actor.
 *   - If it does NOT resolve (remote instance dead / gone) → DELETE those orphan
 *     posts AND the orphan `FederatedActor`.
 *
 * It also deletes `FederatedActor` rows that have no `oxyUserId` and no
 * referencing posts (pure orphan actors).
 *
 * Idempotent and re-runnable: after a real run nothing matches. Supports
 * `DRY_RUN=1` (preview, zero writes / zero network) and `BATCH_SIZE` (progress +
 * orphan-actor page size). Connects via the same `MONGODB_URI` the backend uses
 * (`connectToDatabase`). Prints a final JSON summary; closes the connection in a
 * `finally`.
 *
 * Runnable as a Fargate one-shot post-deploy (against task-def `mention`):
 *   DRY_RUN=1 node dist/src/scripts/cleanup-orphan-federated.js   # preview
 *   node dist/src/scripts/cleanup-orphan-federated.js             # resolve / delete
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import FederatedActor, { type IFederatedActor } from '../models/FederatedActor';
import { connectToDatabase } from '../utils/database';
import { actorService } from '../services/federation/ActorService';
import { logger } from '../utils/logger';

const DRY_RUN = ['1', 'true', 'yes'].includes((process.env.DRY_RUN || '').trim().toLowerCase());

/** Distinct orphan actors processed between progress logs, and orphan-actor page size. */
const BATCH_SIZE = Math.max(1, Number.parseInt(process.env.BATCH_SIZE || '200', 10) || 200);

/**
 * "Has no Oxy author" predicate: `oxyUserId` is explicitly null OR absent. Shared
 * by the post filter and the actor filter so both target the same orphan set.
 */
const NO_OXY_USER: Array<Record<string, unknown>> = [{ oxyUserId: null }, { oxyUserId: { $exists: false } }];

/** Orphan federated posts: a federated post (with an actor URI) that has no Oxy author. */
const ORPHAN_POST_FILTER: Record<string, unknown> = {
  federation: { $ne: null },
  'federation.actorUri': { $exists: true, $ne: null },
  $or: NO_OXY_USER,
};

interface CleanupStats {
  dryRun: boolean;
  orphanPosts: number;
  distinctActors: number;
  /** Actors that resolved to an Oxy user (orphan posts re-attributed). */
  resolved: number;
  /** Actors that already carried an `oxyUserId` (no network resolution needed). */
  resolvedFromCache: number;
  /** Actors that could not be resolved (remote dead) — their orphans were deleted. */
  unresolved: number;
  postsUpdated: number;
  postsDeleted: number;
  actorsDeleted: number;
  errors: number;
}

/**
 * Resolve an orphan actor URI to an Oxy user id (real run only).
 *
 * Prefers the already-stored `FederatedActor.oxyUserId` (no network). Otherwise
 * re-fetches the actor — which runs Oxy's `PUT /users/resolve` and stamps
 * `oxyUserId` — then re-reads the canonical actor's `oxyUserId` (the fetch may
 * have redirected to the actor's canonical URI via WebFinger). Returns null when
 * the actor cannot be resolved.
 */
async function resolveActorOxyUserId(actorUri: string): Promise<string | null> {
  const existing = await FederatedActor.findOne(
    { uri: actorUri },
    { oxyUserId: 1, acct: 1 },
  ).lean<Pick<IFederatedActor, 'oxyUserId' | 'acct'> | null>();

  if (existing?.oxyUserId) return existing.oxyUserId;

  const fetched = await actorService.fetchRemoteActor(actorUri, false, existing?.acct);
  if (!fetched) return null;

  const refreshed = await FederatedActor.findOne(
    { uri: fetched.uri },
    { oxyUserId: 1 },
  ).lean<Pick<IFederatedActor, 'oxyUserId'> | null>();

  return refreshed?.oxyUserId ?? null;
}

/** Orphan-post filter scoped to a single actor URI. */
function orphanPostsOfActor(actorUri: string): Record<string, unknown> {
  return { 'federation.actorUri': actorUri, $or: NO_OXY_USER };
}

/** Orphan-actor filter scoped to a single actor URI. */
function orphanActorByUri(actorUri: string): Record<string, unknown> {
  return { uri: actorUri, $or: NO_OXY_USER };
}

async function cleanupOrphanFederated(): Promise<void> {
  const startedAt = Date.now();
  const stats: CleanupStats = {
    dryRun: DRY_RUN,
    orphanPosts: 0,
    distinctActors: 0,
    resolved: 0,
    resolvedFromCache: 0,
    unresolved: 0,
    postsUpdated: 0,
    postsDeleted: 0,
    actorsDeleted: 0,
    errors: 0,
  };

  try {
    await connectToDatabase();
    logger.info(
      `[cleanup-orphan-federated] connected to MongoDB${DRY_RUN ? ' — DRY_RUN (no writes, no network)' : ''}`,
    );

    stats.orphanPosts = await Post.countDocuments(ORPHAN_POST_FILTER);

    // Distinct actor URIs that authored at least one orphan post.
    const rawUris = await Post.distinct('federation.actorUri', ORPHAN_POST_FILTER);
    const actorUris = rawUris.filter((u): u is string => typeof u === 'string' && u.length > 0);
    stats.distinctActors = actorUris.length;

    logger.info(
      `[cleanup-orphan-federated] ${stats.orphanPosts} orphan post(s) across ${stats.distinctActors} distinct actor(s)`,
    );

    // ----- Phase 2: per-actor resolve (update) or delete -----
    let processed = 0;
    for (const actorUri of actorUris) {
      try {
        if (DRY_RUN) {
          // Zero-network preview: only the already-resolved actors can be
          // reported as definite updates; the rest WOULD attempt network
          // resolution (resolve→update or dead→delete) on a real run.
          const cached = await FederatedActor.findOne(
            { uri: actorUri },
            { oxyUserId: 1 },
          ).lean<Pick<IFederatedActor, 'oxyUserId'> | null>();
          const orphanCount = await Post.countDocuments(orphanPostsOfActor(actorUri));
          if (cached?.oxyUserId) {
            stats.resolved += 1;
            stats.resolvedFromCache += 1;
            stats.postsUpdated += orphanCount;
          } else {
            // Unknown until a real run probes the network — count as "would
            // attempt"; the real run splits these into resolved vs unresolved.
            stats.unresolved += 1;
          }
        } else {
          const hadCachedId = Boolean(
            (
              await FederatedActor.findOne({ uri: actorUri }, { oxyUserId: 1 }).lean<
                Pick<IFederatedActor, 'oxyUserId'> | null
              >()
            )?.oxyUserId,
          );
          const oxyUserId = await resolveActorOxyUserId(actorUri);

          if (oxyUserId) {
            const res = await Post.updateMany(orphanPostsOfActor(actorUri), { $set: { oxyUserId } });
            stats.resolved += 1;
            if (hadCachedId) stats.resolvedFromCache += 1;
            stats.postsUpdated += res.modifiedCount ?? 0;
            logger.info(
              `[cleanup-orphan-federated] resolved ${actorUri} → ${oxyUserId}; updated ${res.modifiedCount ?? 0} post(s)`,
            );
          } else {
            const delPosts = await Post.deleteMany(orphanPostsOfActor(actorUri));
            const delActor = await FederatedActor.deleteMany(orphanActorByUri(actorUri));
            stats.unresolved += 1;
            stats.postsDeleted += delPosts.deletedCount ?? 0;
            stats.actorsDeleted += delActor.deletedCount ?? 0;
            logger.info(
              `[cleanup-orphan-federated] unresolved (dead) ${actorUri}; deleted ${delPosts.deletedCount ?? 0} post(s) + ${delActor.deletedCount ?? 0} actor(s)`,
            );
          }
        }
      } catch (err) {
        stats.errors += 1;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[cleanup-orphan-federated] error processing actor ${actorUri}: ${message}`);
      }

      processed += 1;
      if (processed % BATCH_SIZE === 0) {
        logger.info(
          `[cleanup-orphan-federated] progress: ${processed}/${stats.distinctActors} actors processed`,
        );
      }
    }

    // ----- Phase 3: delete pure orphan actors (no oxyUserId, no referencing posts) -----
    // Paged by a stable ascending `_id` cursor over actors lacking an Oxy user.
    let actorsScanned = 0;
    let lastId: mongoose.Types.ObjectId | null = null;
    for (;;) {
      const pageFilter: Record<string, unknown> = { $or: NO_OXY_USER };
      if (lastId) pageFilter._id = { $gt: lastId };

      const page = await FederatedActor.find(pageFilter, { _id: 1, uri: 1, acct: 1 })
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .lean<Array<{ _id: mongoose.Types.ObjectId; uri: string; acct?: string }>>();

      if (page.length === 0) break;

      for (const actor of page) {
        const hasPosts = await Post.exists({ 'federation.actorUri': actor.uri });
        if (hasPosts) continue;
        if (DRY_RUN) {
          stats.actorsDeleted += 1;
        } else {
          const del = await FederatedActor.deleteOne({ _id: actor._id });
          stats.actorsDeleted += del.deletedCount ?? 0;
          logger.info(
            `[cleanup-orphan-federated] deleted pure orphan actor acct=${actor.acct ?? '<none>'} uri=${actor.uri}`,
          );
        }
      }

      actorsScanned += page.length;
      lastId = page[page.length - 1]._id;
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[cleanup-orphan-federated] done${DRY_RUN ? ' (DRY_RUN)' : ''} in ${elapsedSeconds}s; scanned ${actorsScanned} orphan-actor row(s) in phase 3`,
    );
    logger.info(`[cleanup-orphan-federated] summary: ${JSON.stringify(stats)}`);
  } catch (error) {
    logger.error('[cleanup-orphan-federated] failed', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect().catch((err) => {
      logger.warn('[cleanup-orphan-federated] error during disconnect', err);
    });
  }
}

if (require.main === module) {
  cleanupOrphanFederated();
}

export default cleanupOrphanFederated;
