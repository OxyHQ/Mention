/**
 * One-shot reconciliation: converge the `externalId` index on the
 * `federatedactors` collection to EXACTLY the model's intended spec.
 *
 * Why this exists
 * ---------------
 * The atproto (Bluesky) connector introduced an `externalId` field (the remote
 * DID) on `FederatedActor`, intended to be a SPARSE + UNIQUE index — sparse so
 * the many ActivityPub actors that carry NO `externalId` (null/absent) don't
 * collide on a unique constraint. If prod instead carries a LEGACY/ORPHANED
 * `externalId_1` index whose options drifted from that spec (most dangerously a
 * NON-sparse unique index), every AP actor write with a null/absent `externalId`
 * collides → E11000 → federated actor creation breaks platform-wide.
 *
 * `autoIndex`/`autoCreate` are DISABLED in production (see
 * `src/utils/database.ts`), so mongoose does NOT sync indexes on boot: a wrong
 * index neither self-heals nor self-removes there. This script is the explicit,
 * audited convergence step.
 *
 * Intended spec (derived, not guessed)
 * ------------------------------------
 * The script reads the intended `externalId` index spec from the live
 * `FederatedActor` schema (`schema.indexes()`). If the model declares an
 * `externalId`-keyed index, that declaration is authoritative. If the model does
 * NOT declare one (the field has been consolidated onto `uri` in the canonical
 * model), the script falls back to the connector lineage's canonical spec —
 * `{ unique: true, sparse: true }` — which is also exactly the safe shape that a
 * non-sparse-unique orphan must be converged to. Either way the collection is
 * NEVER left without a correct `externalId` index.
 *
 * Safety / modes
 * --------------
 *   - DEFAULT = INSPECT: lists every index on `federatedactors` (the evidence
 *     dump), reports what WOULD change, and exits 0 WITHOUT mutating anything.
 *   - APPLY (`APPLY=true`): drops the mismatched `externalId`-keyed index (if
 *     any) then (re)creates the correct one so the collection is never left
 *     without it, re-lists indexes, and logs the final state.
 *
 * Idempotent: when the correct index already exists and no wrong one is present,
 * both modes are a clean no-op. Never throws on "index not found" — it logs and
 * continues. Always disconnects mongoose and exits 0 on success so the Fargate
 * one-shot terminates.
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   INSPECT (default, safe):  node dist/src/scripts/reconcileFederatedActorExternalIdIndex.js
 *   APPLY (mutates prod):     APPLY=true node dist/src/scripts/reconcileFederatedActorExternalIdIndex.js
 */

import mongoose from 'mongoose';
import { FederatedActor } from '../models/FederatedActor';
import { logger } from '../utils/logger';

const LOG_PREFIX = '[reconcileFederatedActorExternalIdIndex]';

/** The field whose index we reconcile. */
const TARGET_FIELD = 'externalId';

/** The expected (sole) key shape of the target index: ascending on the field. */
const TARGET_KEY: Record<string, number> = { [TARGET_FIELD]: 1 };

/**
 * The canonical fallback spec for the `externalId` index when the model does NOT
 * declare one. Sparse + unique: a remote id maps to at most one row, while the
 * many actors with no `externalId` are exempt from the unique constraint.
 */
const CANONICAL_FALLBACK_OPTIONS: IntendedIndexOptions = { unique: true, sparse: true };

/** The subset of index options that materially define correctness for us. */
interface IntendedIndexOptions {
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}

/** A live index as returned by `collection.indexes()` / `listIndexes`. */
interface LiveIndex {
  name?: string;
  key?: Record<string, number>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  [extra: string]: unknown;
}

/**
 * Does an index's key consist solely of `{ externalId: 1 }`? We match on key
 * shape (not name) so a differently-named legacy index on the same field is
 * still caught.
 */
function isTargetKey(key: Record<string, number> | undefined): boolean {
  if (!key) return false;
  const entries = Object.entries(key);
  return entries.length === 1 && entries[0][0] === TARGET_FIELD && entries[0][1] === 1;
}

/** Stable JSON for comparing/logging option objects (sorted keys). */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

/** Normalize options to just the fields that define correctness. */
function normalizeOptions(options: IntendedIndexOptions): IntendedIndexOptions {
  const normalized: IntendedIndexOptions = {};
  if (options.unique) normalized.unique = true;
  if (options.sparse) normalized.sparse = true;
  if (options.partialFilterExpression && Object.keys(options.partialFilterExpression).length > 0) {
    normalized.partialFilterExpression = options.partialFilterExpression;
  }
  return normalized;
}

function optionsEqual(a: IntendedIndexOptions, b: IntendedIndexOptions): boolean {
  return stableStringify(normalizeOptions(a)) === stableStringify(normalizeOptions(b));
}

/**
 * Resolve the intended `externalId` index options from the live model schema.
 * Returns the model's own declaration when present; otherwise the canonical
 * sparse+unique fallback. Logs which source won so the run is self-explaining.
 */
function resolveIntendedOptions(): IntendedIndexOptions {
  // `schema.indexes()` → array of `[keySpec, optionsObject]` tuples.
  const declared = FederatedActor.schema
    .indexes()
    .find(([key]) => isTargetKey(key as Record<string, number>));

  if (declared) {
    const [, declaredOptions] = declared as [Record<string, number>, IntendedIndexOptions];
    const intended = normalizeOptions(declaredOptions || {});
    logger.info(
      `${LOG_PREFIX} intended spec sourced from model schema: ${stableStringify(intended)}`,
    );
    return intended;
  }

  logger.info(
    `${LOG_PREFIX} model schema declares no ${TARGET_FIELD} index; using canonical fallback spec: ${stableStringify(
      CANONICAL_FALLBACK_OPTIONS,
    )}`,
  );
  return normalizeOptions(CANONICAL_FALLBACK_OPTIONS);
}

/** List + log every index on the collection (the evidence dump). */
async function dumpIndexes(label: string): Promise<LiveIndex[]> {
  let indexes: LiveIndex[] = [];
  try {
    indexes = (await FederatedActor.collection.indexes()) as LiveIndex[];
  } catch (error) {
    // A brand-new/empty collection may not exist yet → treat as no indexes.
    logger.warn(`${LOG_PREFIX} could not list indexes (${label}); treating as none`, error);
    return [];
  }

  logger.info(`${LOG_PREFIX} ${label}: ${indexes.length} index(es) on federatedactors`);
  for (const idx of indexes) {
    logger.info(
      `${LOG_PREFIX}   - name=${idx.name ?? '(unnamed)'} key=${stableStringify(
        idx.key ?? {},
      )} options=${stableStringify(
        normalizeOptions({
          unique: idx.unique,
          sparse: idx.sparse,
          partialFilterExpression: idx.partialFilterExpression,
        }),
      )}`,
    );
  }
  return indexes;
}

async function reconcileFederatedActorExternalIdIndex(): Promise<void> {
  const startedAt = Date.now();
  const apply = process.env.APPLY === 'true';
  const mode = apply ? 'APPLY' : 'INSPECT';

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    logger.error(`${LOG_PREFIX} MONGODB_URI is not set; cannot connect`);
    process.exit(1);
    return;
  }
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    // autoIndex/autoCreate off: this script is the ONLY thing that touches
    // indexes here, so model load must not implicitly build any.
    await mongoose.connect(mongoUri, { dbName, autoIndex: false, autoCreate: false });
    logger.info(`${LOG_PREFIX} connected to MongoDB (${dbName}) — mode=${mode}`);

    const intended = resolveIntendedOptions();

    const before = await dumpIndexes('current indexes');
    const targetIndexes = before.filter(idx => isTargetKey(idx.key));

    if (targetIndexes.length === 0) {
      // No externalId index at all. The model expects one to exist; ensure it.
      logger.info(
        `${LOG_PREFIX} no ${TARGET_FIELD} index present. Intended: ${stableStringify(intended)}`,
      );
      if (!apply) {
        logger.info(
          `${LOG_PREFIX} INSPECT: WOULD create ${TARGET_FIELD} index ${stableStringify(
            TARGET_KEY,
          )} with options ${stableStringify(intended)}. No changes made.`,
        );
      } else {
        await createTargetIndex(intended);
        await dumpIndexes('final indexes');
      }
      await finish(startedAt, mode);
      return;
    }

    // Determine which existing target-keyed indexes match vs. mismatch.
    const mismatched = targetIndexes.filter(
      idx =>
        !optionsEqual(
          {
            unique: idx.unique,
            sparse: idx.sparse,
            partialFilterExpression: idx.partialFilterExpression,
          },
          intended,
        ),
    );
    const matched = targetIndexes.filter(idx => !mismatched.includes(idx));

    if (mismatched.length === 0) {
      logger.info(
        `${LOG_PREFIX} ${TARGET_FIELD} index already matches intended spec ${stableStringify(
          intended,
        )} (name=${matched.map(i => i.name).join(', ')}). Clean no-op.`,
      );
      await finish(startedAt, mode);
      return;
    }

    // There is at least one mismatched externalId index.
    for (const idx of mismatched) {
      const current = normalizeOptions({
        unique: idx.unique,
        sparse: idx.sparse,
        partialFilterExpression: idx.partialFilterExpression,
      });
      logger.warn(
        `${LOG_PREFIX} MISMATCH: index name=${idx.name ?? '(unnamed)'} key=${stableStringify(
          idx.key ?? {},
        )} has options ${stableStringify(current)} ≠ intended ${stableStringify(intended)}`,
      );
    }

    if (!apply) {
      logger.info(
        `${LOG_PREFIX} INSPECT: WOULD drop ${mismatched
          .map(i => i.name ?? '(unnamed)')
          .join(', ')} and ${
          matched.length > 0 ? 'keep the already-correct index' : 'ensure'
        } a ${TARGET_FIELD} index with options ${stableStringify(
          intended,
        )}. No changes made.`,
      );
      await finish(startedAt, mode);
      return;
    }

    // APPLY: drop each mismatched index, then ensure the correct one exists.
    for (const idx of mismatched) {
      await dropIndexByName(idx.name);
    }

    // If a correctly-specced index already coexisted, we keep it; otherwise create.
    if (matched.length === 0) {
      await createTargetIndex(intended);
    } else {
      logger.info(
        `${LOG_PREFIX} a correctly-specced ${TARGET_FIELD} index already exists (name=${matched
          .map(i => i.name)
          .join(', ')}); no creation needed.`,
      );
    }

    await dumpIndexes('final indexes');
    await finish(startedAt, mode);
  } catch (error) {
    logger.error(`${LOG_PREFIX} failed`, error);
    await safeDisconnect();
    process.exit(1);
  }
}

/** Create the intended externalId index, tolerating an already-exists race. */
async function createTargetIndex(intended: IntendedIndexOptions): Promise<void> {
  try {
    const name = await FederatedActor.collection.createIndex(TARGET_KEY, { ...intended });
    logger.info(
      `${LOG_PREFIX} created ${TARGET_FIELD} index (name=${name}) with options ${stableStringify(
        intended,
      )}`,
    );
  } catch (error) {
    // IndexOptionsConflict / IndexKeySpecsConflict (85/86) or already-exists:
    // log and continue — the goal is convergence, not a hard guarantee of a
    // fresh build when an equivalent index is already in place.
    logger.warn(
      `${LOG_PREFIX} createIndex for ${TARGET_FIELD} did not complete cleanly (may already exist); continuing`,
      error,
    );
  }
}

/** Drop an index by name, never throwing on "not found". */
async function dropIndexByName(name: string | undefined): Promise<void> {
  if (!name) {
    logger.warn(`${LOG_PREFIX} cannot drop an unnamed index; skipping`);
    return;
  }
  try {
    await FederatedActor.collection.dropIndex(name);
    logger.info(`${LOG_PREFIX} dropped index ${name}`);
  } catch (error) {
    // IndexNotFound (27) or already gone: log + continue (idempotent).
    logger.warn(`${LOG_PREFIX} dropIndex(${name}) failed (likely already absent); continuing`, error);
  }
}

async function finish(startedAt: number, mode: string): Promise<void> {
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  logger.info(`${LOG_PREFIX} done (mode=${mode}, ${elapsedSeconds}s)`);
  await safeDisconnect();
  process.exit(0);
}

async function safeDisconnect(): Promise<void> {
  try {
    await mongoose.disconnect();
  } catch (error) {
    logger.warn(`${LOG_PREFIX} error during mongoose.disconnect()`, error);
  }
}

if (require.main === module) {
  reconcileFederatedActorExternalIdIndex();
}

export default reconcileFederatedActorExternalIdIndex;
