/**
 * One-shot repair: re-link self-thread continuations that the old `createThread`
 * bug stored as a flat FAN back into a sequential CHAIN.
 *
 * THE BUG (now fixed going forward): for every continuation post (i > 0) the old
 * `createThread` loop set BOTH `parentPostId = mainPostId` AND
 * `threadId = mainPostId`, where `mainPostId` is the FIRST/root post's id. So all
 * continuations pointed at the root (a fan) instead of forming a chain. The root
 * post (i === 0) got NO `threadId` and NO `parentPostId` — its `_id` equals the
 * `threadId` carried by its continuations.
 *
 * THE REPAIR: within a thread (continuations sharing `threadId === T`), ordered by
 * creation order (ascending `_id`), the first continuation keeps `parentPostId = T`
 * (it correctly replies to the root); each subsequent continuation is re-pointed at
 * the PREVIOUS continuation (`continuation[k].parentPostId = continuation[k-1]._id`).
 * `threadId` stays `= T` for all. Only `parentPostId` is ever written.
 *
 * SAFETY — the candidate set is NARROWER than "any post with a non-null threadId".
 * A non-null `threadId` does NOT uniquely identify self-thread continuations: the
 * native reply path (`feed.controller.createReply`) ALSO stamps
 * `threadId = parentPost.threadId ?? parentPost._id` on every reply, and the
 * federated reply backfill stamps it too. Re-chaining a real reply tree by `_id`
 * order would corrupt conversations. To touch ONLY genuine broken fans, a thread
 * qualifies for repair iff ALL of the following hold:
 *   1. NATIVE only — its members have no `federation.activityId` (the bug was a
 *      native-`createThread` bug; federated threads are structured via inReplyTo).
 *   2. SINGLE AUTHOR — every native member shares one `oxyUserId` (a self-thread is
 *      authored entirely by the thread creator; this excludes multi-user threads).
 *   3. PURE FAN — every native member currently has `parentPostId === threadId`
 *      (i.e. all point at the root, with NO nesting). This is the exact output of
 *      the old bug. Any nested member (a real reply / a branching self-reply tree)
 *      makes the thread NOT a pure fan, so it is skipped — never corrupted.
 *   4. ROOT VERIFIED — the root post (`_id === threadId`) exists, is native, and is
 *      authored by that same single author (excludes "user replied to someone
 *      else's post N times").
 *   5. 2+ continuations — a 2-post thread (root + 1 continuation) is already a
 *      correct chain (the lone continuation correctly replies to the root), so it
 *      is skipped.
 *
 * Once repaired, a thread is a chain (not a pure fan) so it no longer matches
 * condition 3 — making this script IDEMPOTENT: re-running is a no-op. A partially
 * chained thread (e.g. from an interrupted run) is likewise not a pure fan, so it
 * is skipped rather than risk a wrong linear re-chain (the safe direction).
 *
 * Counts are NOT touched: the old `createThread` created continuations via
 * `new Post()` / `save()` (NOT the reply path), so it never bumped the root's
 * `stats.commentsCount`. Re-linking `parentPostId` therefore needs no count
 * recompute, and this migration deliberately leaves all counters (and content,
 * `threadId`, and the root post) untouched. Engagement-count reconciliation is a
 * separate concern owned by `recomputeFederatedEngagement.ts`.
 *
 * Runnable as a Fargate one-shot post-deploy (DRY_RUN first):
 *   DRY_RUN=true bun packages/backend/dist/src/scripts/migrateThreadFanToChain.js
 *   bun packages/backend/dist/src/scripts/migrateThreadFanToChain.js
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';

/**
 * A thread needs 2+ continuations to be a broken fan worth repairing. A thread
 * with a single continuation is already a correct chain (that one continuation
 * correctly replies to the root).
 */
const MIN_CONTINUATIONS_FOR_REPAIR = 2;

/** Root posts fetched per `$in` chunk when verifying thread ownership. */
const ROOT_FETCH_CHUNK_SIZE = 500;

/** `parentPostId` re-link writes flushed per `bulkWrite` chunk. */
const BULK_CHUNK_SIZE = 500;

/** Candidate threads reported per progress line. */
const PROGRESS_EVERY = 500;

const DRY_RUN = process.env.DRY_RUN === 'true';

/** One continuation of a candidate thread, as collected by the aggregation. */
interface ContinuationRow {
  id: mongoose.Types.ObjectId;
  parentPostId: string | null;
}

/** A candidate broken-fan thread group from the aggregation. */
interface CandidateThreadGroup {
  /** The shared `threadId` (the root post's id, as a string). */
  _id: string;
  count: number;
  authors: string[];
  continuations: ContinuationRow[];
}

/** Minimal root-post projection used to verify thread ownership. */
interface RootRow {
  _id: mongoose.Types.ObjectId;
  oxyUserId?: string;
}

/**
 * Find candidate broken-fan threads: NATIVE, single-author, pure-fan groups (every
 * member's `parentPostId === threadId`) with 2+ continuations. Root ownership is
 * verified separately. Already-chained or partially-chained threads are not pure
 * fans, so the pipeline never returns them (idempotency at the source).
 */
function buildCandidatePipeline(): mongoose.PipelineStage[] {
  return [
    {
      $match: {
        threadId: { $ne: null },
        // Native posts only — federated posts carry `federation.activityId`.
        'federation.activityId': { $exists: false },
      },
    },
    {
      $group: {
        _id: '$threadId',
        count: { $sum: 1 },
        authors: { $addToSet: '$oxyUserId' },
        // Members whose parentPostId does NOT equal the threadId (i.e. nested /
        // non-fan). A genuine broken fan has zero of these.
        nonFanCount: {
          $sum: { $cond: [{ $eq: ['$parentPostId', '$threadId'] }, 0, 1] },
        },
        continuations: { $push: { id: '$_id', parentPostId: '$parentPostId' } },
      },
    },
    {
      $match: {
        count: { $gte: MIN_CONTINUATIONS_FOR_REPAIR },
        // Pure fan: every member points at the root.
        nonFanCount: 0,
        // Exactly one distinct author (a second author would expose `authors.1`).
        'authors.1': { $exists: false },
      },
    },
  ];
}

/**
 * Batch-fetch the root posts (`_id === threadId`) for the candidate threads and
 * return a map of rootId string -> author oxyUserId, restricted to NATIVE roots.
 * Threads whose root is missing, federated, or absent from this map fail ownership
 * verification and are skipped.
 */
async function loadRootAuthors(threadIds: string[]): Promise<Map<string, string | undefined>> {
  const rootAuthorById = new Map<string, string | undefined>();
  const validObjectIds = threadIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  for (let i = 0; i < validObjectIds.length; i += ROOT_FETCH_CHUNK_SIZE) {
    const chunk = validObjectIds.slice(i, i + ROOT_FETCH_CHUNK_SIZE);
    const roots = await Post.find(
      { _id: { $in: chunk }, 'federation.activityId': { $exists: false } },
      { _id: 1, oxyUserId: 1 },
    ).lean<RootRow[]>();
    for (const root of roots) {
      rootAuthorById.set(root._id.toString(), root.oxyUserId);
    }
  }

  return rootAuthorById;
}

/** Stable creation-order sort: ascending ObjectId hex compares as creation order. */
function byIdAscending(a: ContinuationRow, b: ContinuationRow): number {
  const aId = a.id.toString();
  const bId = b.id.toString();
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

async function migrateThreadFanToChain(): Promise<void> {
  const startedAt = Date.now();

  await connectToDatabase();
  logger.info(`[migrateThreadFanToChain] connected to MongoDB; DRY_RUN=${DRY_RUN}`);

  const candidates = await Post.aggregate<CandidateThreadGroup>(buildCandidatePipeline());
  logger.info(
    `[migrateThreadFanToChain] ${candidates.length} candidate broken-fan threads (native, single-author, pure fan, ${MIN_CONTINUATIONS_FOR_REPAIR}+ continuations)`,
  );

  if (candidates.length === 0) {
    logger.info('[migrateThreadFanToChain] nothing to do');
    return;
  }

  const rootAuthorById = await loadRootAuthors(candidates.map((c) => c._id));

  let threadsScanned = 0;
  let threadsRepaired = 0;
  let threadsSkippedOwnership = 0;
  let postsRelinkPlanned = 0;
  let postsRelinkWritten = 0;
  let pendingOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];

  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0) return;
    if (DRY_RUN) {
      pendingOps = [];
      return;
    }
    const result = await Post.bulkWrite(pendingOps, { ordered: false });
    postsRelinkWritten += result.modifiedCount;
    pendingOps = [];
  };

  for (const group of candidates) {
    threadsScanned += 1;
    const threadId = group._id;
    const author = group.authors[0];

    // Ownership: the root (_id === threadId) must exist, be native, and be authored
    // by the SAME single author as the continuations. Excludes "user replied to
    // someone else's post N times" and missing/federated roots.
    const rootAuthor = rootAuthorById.get(threadId);
    if (rootAuthor === undefined || rootAuthor !== author) {
      threadsSkippedOwnership += 1;
      continue;
    }

    const continuations = [...group.continuations].sort(byIdAscending);

    let threadHasRelink = false;
    for (let k = 0; k < continuations.length; k++) {
      const current = continuations[k];
      // First continuation correctly replies to the root; each subsequent one
      // should reply to the immediately-previous continuation.
      const correctParent = k === 0 ? threadId : continuations[k - 1].id.toString();

      // Idempotent: only write posts whose parentPostId is wrong. (For an
      // untouched fan this is exactly continuations[1..n-1].)
      if (current.parentPostId === correctParent) continue;

      threadHasRelink = true;
      postsRelinkPlanned += 1;
      pendingOps.push({
        updateOne: {
          filter: { _id: current.id },
          update: { $set: { parentPostId: correctParent } },
        },
      });

      if (pendingOps.length >= BULK_CHUNK_SIZE) {
        await flush();
      }
    }

    if (threadHasRelink) {
      threadsRepaired += 1;
    }

    if (threadsScanned % PROGRESS_EVERY === 0) {
      logger.info(
        `[migrateThreadFanToChain] progress: scanned ${threadsScanned}/${candidates.length} threads, repaired ${threadsRepaired}, posts re-linked ${postsRelinkPlanned}, skipped (ownership) ${threadsSkippedOwnership}`,
      );
    }
  }

  await flush();

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  logger.info(
    `[migrateThreadFanToChain] done${DRY_RUN ? ' (DRY_RUN — no writes)' : ''}: ` +
      `candidate threads ${candidates.length}, repaired ${threadsRepaired}, ` +
      `skipped (ownership) ${threadsSkippedOwnership}, ` +
      `posts re-linked ${DRY_RUN ? `${postsRelinkPlanned} (planned)` : `${postsRelinkWritten} written / ${postsRelinkPlanned} planned`} ` +
      `(${elapsedSeconds}s)`,
  );
}

async function run(): Promise<void> {
  try {
    await migrateThreadFanToChain();
    await mongoose.disconnect();
    // Exit explicitly: imported model/service modules may hold open handles
    // (Redis/BullMQ singletons) that would otherwise keep the process alive.
    process.exit(0);
  } catch (error) {
    logger.error('[migrateThreadFanToChain] failed', error);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

export default migrateThreadFanToChain;
