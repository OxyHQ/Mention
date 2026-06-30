/**
 * One-shot reconciliation: converge the `externalId` index on the
 * `federatedactors` collection to EXACTLY what the `FederatedActor` model
 * declares — which today is NOTHING.
 *
 * Why this exists
 * ---------------
 * An earlier atproto (Bluesky) iteration added an `externalId` field (the remote
 * DID) to `FederatedActor` with a sparse+unique index. PR #277 (commit 9a77475e)
 * then CONSOLIDATED that away: the model now keys every actor on `uri`, and
 * `externalId` survives only as an in-memory DTO property (`NormalizedExternalActor`,
 * mapped to `actor.uri`) — it is NEVER persisted or queried on the collection.
 *
 * The model is the source of truth, and it declares NO `externalId` index. So a
 * leftover `externalId_1` index in prod is an ORPHAN: it backs no model field,
 * cannot self-remove (`autoIndex`/`autoCreate` are OFF in production — see
 * `src/utils/database.ts`), and a non-sparse-unique variant E11000s on the many
 * AP actors that carry no `externalId` (null/absent) -> breaks federated actor
 * creation. The correct convergence is therefore DROP-ONLY: remove the orphan,
 * do NOT recreate it.
 *
 * Model-driven (no hardcoded spec)
 * --------------------------------
 * The intended state is read from the live `FederatedActor` schema
 * (`schema.indexes()`):
 *   - If the model DOES declare an `{ externalId: 1 }` index (future-proofing for
 *     a possible re-add), ensure exactly that — drop any mismatched variant and
 *     create the declared one so the collection is never left without it.
 *   - If the model declares NO `externalId` index (today), the end state is "no
 *     index": drop any leftover `{ externalId: 1 }` index and do NOT recreate.
 * There is no canonical/fallback spec — "no declared index -> no index" is the
 * truth.
 *
 * Safety / modes
 * --------------
 *   - DEFAULT = INSPECT: lists every index on `federatedactors` (the evidence
 *     dump), reports what WOULD change, and exits 0 WITHOUT mutating anything.
 *   - APPLY (`APPLY=true`): performs the drop (and, only if the model declares
 *     one, the create), re-lists indexes, and logs the final state.
 *
 * Idempotent: when the live state already matches the model, both modes are a
 * clean no-op. Never throws on "index not found" — it logs and continues. Always
 * disconnects mongoose and exits 0 on success so the Fargate one-shot terminates.
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

/** A live index's correctness-defining options, normalized. */
function liveOptions(idx: LiveIndex): IntendedIndexOptions {
  return normalizeOptions({
    unique: idx.unique,
    sparse: idx.sparse,
    partialFilterExpression: idx.partialFilterExpression,
  });
}

/**
 * Resolve the model's intended `externalId` index from the live schema.
 * Returns the declared options when the model declares an `{ externalId: 1 }`
 * index, or `null` when it declares none (today's end state = "no index").
 * The MODEL is the source of truth; there is no hardcoded fallback spec.
 */
function resolveDeclaredOptions(): IntendedIndexOptions | null {
  // `schema.indexes()` -> array of `[keySpec, optionsObject]` tuples.
  const declared = FederatedActor.schema
    .indexes()
    .find(([key]) => isTargetKey(key as Record<string, number>));

  if (declared) {
    const [, declaredOptions] = declared as [Record<string, number>, IntendedIndexOptions];
    const intended = normalizeOptions(declaredOptions || {});
    logger.info(
      `${LOG_PREFIX} model schema DECLARES a ${TARGET_FIELD} index; intended spec: ${stableStringify(
        intended,
      )}`,
    );
    return intended;
  }

  logger.info(
    `${LOG_PREFIX} model schema declares NO ${TARGET_FIELD} index; end state = no ${TARGET_FIELD} index (drop-only)`,
  );
  return null;
}

/** List + log every index on the collection (the evidence dump). */
async function dumpIndexes(label: string): Promise<LiveIndex[]> {
  let indexes: LiveIndex[] = [];
  try {
    indexes = (await FederatedActor.collection.indexes()) as LiveIndex[];
  } catch (error) {
    // A brand-new/empty collection may not exist yet -> treat as no indexes.
    logger.warn(`${LOG_PREFIX} could not list indexes (${label}); treating as none`, error);
    return [];
  }

  logger.info(`${LOG_PREFIX} ${label}: ${indexes.length} index(es) on federatedactors`);
  for (const idx of indexes) {
    logger.info(
      `${LOG_PREFIX}   - name=${idx.name ?? '(unnamed)'} key=${stableStringify(
        idx.key ?? {},
      )} options=${stableStringify(liveOptions(idx))}`,
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

    const declared = resolveDeclaredOptions();

    const before = await dumpIndexes('current indexes');
    const targetIndexes = before.filter(idx => isTargetKey(idx.key));

    if (declared === null) {
      await reconcileNoDeclaredIndex(targetIndexes, apply);
      await finish(startedAt, mode);
      return;
    }

    await reconcileDeclaredIndex(declared, targetIndexes, apply);
    await finish(startedAt, mode);
  } catch (error) {
    logger.error(`${LOG_PREFIX} failed`, error);
    await safeDisconnect();
    process.exit(1);
  }
}

/**
 * Model declares NO externalId index: end state = no index.
 * Drop any leftover `{ externalId: 1 }` index; never recreate.
 */
async function reconcileNoDeclaredIndex(targetIndexes: LiveIndex[], apply: boolean): Promise<void> {
  if (targetIndexes.length === 0) {
    logger.info(
      `${LOG_PREFIX} no ${TARGET_FIELD} index present and model declares none. Clean no-op.`,
    );
    return;
  }

  for (const idx of targetIndexes) {
    logger.warn(
      `${LOG_PREFIX} ORPHAN: index name=${idx.name ?? '(unnamed)'} key=${stableStringify(
        idx.key ?? {},
      )} options=${stableStringify(
        liveOptions(idx),
      )} backs no model field (model declares no ${TARGET_FIELD} index)`,
    );
  }

  if (!apply) {
    logger.info(
      `${LOG_PREFIX} INSPECT: WOULD drop orphan ${TARGET_FIELD} index ${targetIndexes
        .map(i => i.name ?? '(unnamed)')
        .join(', ')}; model declares none, so it will NOT be recreated. No changes made.`,
    );
    return;
  }

  for (const idx of targetIndexes) {
    await dropIndexByName(idx.name);
  }
  await dumpIndexes('final indexes');
}

/**
 * Model DECLARES an externalId index (future-proofing): ensure exactly that —
 * drop any mismatched variant, create the declared one if absent.
 */
async function reconcileDeclaredIndex(
  declared: IntendedIndexOptions,
  targetIndexes: LiveIndex[],
  apply: boolean,
): Promise<void> {
  const mismatched = targetIndexes.filter(idx => !optionsEqual(liveOptions(idx), declared));
  const matched = targetIndexes.filter(idx => !mismatched.includes(idx));

  if (targetIndexes.length > 0 && mismatched.length === 0) {
    logger.info(
      `${LOG_PREFIX} ${TARGET_FIELD} index already matches declared spec ${stableStringify(
        declared,
      )} (name=${matched.map(i => i.name).join(', ')}). Clean no-op.`,
    );
    return;
  }

  for (const idx of mismatched) {
    logger.warn(
      `${LOG_PREFIX} MISMATCH: index name=${idx.name ?? '(unnamed)'} key=${stableStringify(
        idx.key ?? {},
      )} has options ${stableStringify(liveOptions(idx))} ≠ declared ${stableStringify(declared)}`,
    );
  }

  if (!apply) {
    const actions: string[] = [];
    if (mismatched.length > 0) {
      actions.push(`drop ${mismatched.map(i => i.name ?? '(unnamed)').join(', ')}`);
    }
    if (matched.length === 0) {
      actions.push(`create ${TARGET_FIELD} index with options ${stableStringify(declared)}`);
    } else {
      actions.push('keep the already-correct index');
    }
    logger.info(`${LOG_PREFIX} INSPECT: WOULD ${actions.join(' and ')}. No changes made.`);
    return;
  }

  // APPLY: drop mismatched, then ensure the declared index exists.
  for (const idx of mismatched) {
    await dropIndexByName(idx.name);
  }
  if (matched.length === 0) {
    await createTargetIndex(declared);
  } else {
    logger.info(
      `${LOG_PREFIX} a correctly-specced ${TARGET_FIELD} index already exists (name=${matched
        .map(i => i.name)
        .join(', ')}); no creation needed.`,
    );
  }
  await dumpIndexes('final indexes');
}

/** Create the declared externalId index, tolerating an already-exists race. */
async function createTargetIndex(declared: IntendedIndexOptions): Promise<void> {
  try {
    const name = await FederatedActor.collection.createIndex(TARGET_KEY, { ...declared });
    logger.info(
      `${LOG_PREFIX} created ${TARGET_FIELD} index (name=${name}) with options ${stableStringify(
        declared,
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
