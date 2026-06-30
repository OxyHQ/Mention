/**
 * One-shot repair: stamp `threadId = root._id` on existing native self-thread
 * ROOTS that currently lack it.
 *
 * THE BUG (now fixed going forward in `createThread`): a compose thread's ROOT
 * post (i === 0) was created with NO `threadId` — only the continuations (i > 0)
 * received `threadId = <root id>`. `ThreadSlicingService.sliceFeed` groups a
 * self-thread into one connected slice ONLY when it finds a thread ROOT matching
 * `post.threadId && !post.parentPostId`, then pulls its same-author continuations
 * via `fetchThreadChildren`. Because the root's `threadId` was null, the root
 * never matched, no children were fetched, and the thread rendered as loose,
 * ungrouped posts. The canonical correct shape (which the continuations and the
 * native reply path already assume) is: EVERY member of a self-thread — INCLUDING
 * the root — shares `threadId === root._id`. The root is the only member that was
 * missing it.
 *
 * THE REPAIR: for each broken root, set `threadId = <its own _id>`. This is purely
 * ADDITIVE and ROOT-ONLY — `parentPostId` and the continuations are NEVER touched.
 *
 * SAFETY — a non-null `threadId` does NOT uniquely identify a self-thread: the
 * native reply path (`feed.controller.createReply`) ALSO stamps
 * `threadId = parentPost.threadId ?? parentPost._id` on every reply, and the
 * federated reply backfill stamps it too. Stamping the root of an arbitrary reply
 * tree (e.g. "user B replied N times under user A's post") would wrongly fold an
 * unrelated author's posts into a single connected slice. To touch ONLY genuine
 * native self-thread roots, a root qualifies for the stamp iff ALL of the
 * following hold:
 *   1. SINGLE AUTHOR — every native member sharing its `threadId` has one
 *      `oxyUserId` (a self-thread is authored entirely by the thread creator; this
 *      excludes multi-user reply trees).
 *   2. ROOT EXISTS — the post `_id === threadId` is present.
 *   3. NATIVE — the root has no `federation.activityId` (the bug + forward fix are
 *      native-`createThread`-only; federated threads are structured via inReplyTo).
 *   4. TRUE TOP-LEVEL — the root has no `parentPostId` (it is the head of the
 *      thread, not itself a reply).
 *   5. NOT-ALREADY-STAMPED — the root's `threadId` is currently null/absent. A root
 *      already carrying a `threadId` (e.g. a post created after the forward fix) is
 *      left untouched. This is what makes the script IDEMPOTENT — a second run finds
 *      every previously-stamped root non-null and skips it.
 *   6. OWNERSHIP — the root's `oxyUserId` equals that single continuation author.
 *      Excludes "user replied to someone else's post N times" — only a root authored
 *      by the same person as its continuations is a real self-thread.
 *
 * Because feeds select top-level posts by `parentPostId` absence (NEVER by
 * `threadId`), stamping the root's `threadId` keeps it in every feed unchanged; it
 * only enables `ThreadSlicingService` to recognise the root and connect the slice,
 * and (incidentally) improves `FeedRankingService` author-diversity dedup. Counts,
 * content, `parentPostId`, and all continuations are deliberately left untouched.
 *
 * Runnable as a Fargate one-shot post-deploy (DRY_RUN first):
 *   DRY_RUN=true bun packages/backend/dist/src/scripts/backfillThreadRootThreadId.js
 *   bun packages/backend/dist/src/scripts/backfillThreadRootThreadId.js
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';

/** Root posts fetched per `$in` chunk when verifying ownership / current state. */
const ROOT_FETCH_CHUNK_SIZE = 500;

/** `threadId` stamp writes flushed per `bulkWrite` chunk. */
const BULK_CHUNK_SIZE = 500;

/** Candidate groups reported per progress line. */
const PROGRESS_EVERY = 500;

const DRY_RUN = process.env.DRY_RUN === 'true';

/** A candidate single-author thread group from the aggregation. */
interface CandidateThreadGroup {
  /** The shared `threadId` (the root post's id, as a string). */
  _id: string;
  count: number;
  authors: string[];
}

/** Minimal root-post projection used to qualify a stamp. */
interface RootRow {
  _id: mongoose.Types.ObjectId;
  oxyUserId?: string;
  parentPostId?: string | null;
  threadId?: string | null;
  federation?: { activityId?: string };
}

/**
 * Find candidate threads: NATIVE members (no `federation.activityId`) carrying a
 * non-null `threadId`, grouped by `threadId`, keeping only groups with EXACTLY ONE
 * distinct author. Root existence/state/ownership is verified separately. Roots are
 * NOT members of these groups when their own `threadId` is null (the broken case),
 * so the group's author set reflects the continuations.
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
      },
    },
    {
      $match: {
        // Exactly one distinct author (a second author would expose `authors.1`).
        'authors.1': { $exists: false },
      },
    },
  ];
}

/**
 * Batch-fetch the root posts (`_id === threadId`) for the candidate threads and
 * return a map of rootId string -> root projection. Threads whose root is absent
 * from this map fail existence verification and are skipped.
 */
async function loadRoots(threadIds: string[]): Promise<Map<string, RootRow>> {
  const rootById = new Map<string, RootRow>();
  const validObjectIds = threadIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  for (let i = 0; i < validObjectIds.length; i += ROOT_FETCH_CHUNK_SIZE) {
    const chunk = validObjectIds.slice(i, i + ROOT_FETCH_CHUNK_SIZE);
    const roots = await Post.find(
      { _id: { $in: chunk } },
      { _id: 1, oxyUserId: 1, parentPostId: 1, threadId: 1, federation: 1 },
    ).lean<RootRow[]>();
    for (const root of roots) {
      rootById.set(root._id.toString(), root);
    }
  }

  return rootById;
}

async function backfillThreadRootThreadId(): Promise<void> {
  const startedAt = Date.now();

  await connectToDatabase();
  logger.info(`[backfillThreadRootThreadId] connected to MongoDB; DRY_RUN=${DRY_RUN}`);

  const candidates = await Post.aggregate<CandidateThreadGroup>(buildCandidatePipeline());
  logger.info(
    `[backfillThreadRootThreadId] ${candidates.length} candidate single-author native thread groups`,
  );

  if (candidates.length === 0) {
    logger.info('[backfillThreadRootThreadId] nothing to do');
    return;
  }

  const rootById = await loadRoots(candidates.map((c) => c._id));

  let groupsScanned = 0;
  let rootsStampedPlanned = 0;
  let rootsStampedWritten = 0;
  let skippedRootMissing = 0;
  let skippedRootFederated = 0;
  let skippedRootHasParent = 0;
  let skippedRootAlreadyStamped = 0;
  let skippedOwnership = 0;
  let pendingOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];

  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0) return;
    if (DRY_RUN) {
      pendingOps = [];
      return;
    }
    const result = await Post.bulkWrite(pendingOps, { ordered: false });
    rootsStampedWritten += result.modifiedCount;
    pendingOps = [];
  };

  for (const group of candidates) {
    groupsScanned += 1;
    const threadId = group._id;
    const author = group.authors[0];

    const root = rootById.get(threadId);

    // The root (_id === threadId) must exist.
    if (root === undefined) {
      skippedRootMissing += 1;
      continue;
    }
    // ...be native (federated threads are structured via inReplyTo, not threadId).
    if (root.federation?.activityId !== undefined) {
      skippedRootFederated += 1;
      continue;
    }
    // ...be a true top-level post (the head of the thread, not itself a reply).
    if (root.parentPostId !== null && root.parentPostId !== undefined) {
      skippedRootHasParent += 1;
      continue;
    }
    // ...currently lack a threadId (idempotency: a root already carrying one — e.g.
    // a post created after the forward fix — is left untouched).
    if (root.threadId !== null && root.threadId !== undefined) {
      skippedRootAlreadyStamped += 1;
      continue;
    }
    // ...and be authored by the SAME single author as its continuations (ownership:
    // excludes reply trees where others replied under someone else's post).
    if (root.oxyUserId !== author) {
      skippedOwnership += 1;
      continue;
    }

    rootsStampedPlanned += 1;
    pendingOps.push({
      updateOne: {
        filter: { _id: root._id },
        update: { $set: { threadId: root._id.toString() } },
      },
    });

    if (pendingOps.length >= BULK_CHUNK_SIZE) {
      await flush();
    }

    if (groupsScanned % PROGRESS_EVERY === 0) {
      logger.info(
        `[backfillThreadRootThreadId] progress: scanned ${groupsScanned}/${candidates.length} groups, roots stamped ${rootsStampedPlanned}`,
      );
    }
  }

  await flush();

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  logger.info(
    `[backfillThreadRootThreadId] done${DRY_RUN ? ' (DRY_RUN — no writes)' : ''}: ` +
      `candidate groups ${candidates.length}, ` +
      `roots stamped ${DRY_RUN ? `${rootsStampedPlanned} (planned)` : `${rootsStampedWritten} written / ${rootsStampedPlanned} planned`}, ` +
      `skipped (root missing) ${skippedRootMissing}, (federated) ${skippedRootFederated}, ` +
      `(has parent) ${skippedRootHasParent}, (already stamped) ${skippedRootAlreadyStamped}, ` +
      `(ownership) ${skippedOwnership} (${elapsedSeconds}s)`,
  );
}

async function run(): Promise<void> {
  try {
    await backfillThreadRootThreadId();
    await mongoose.disconnect();
    // Exit explicitly: imported model/service modules may hold open handles
    // (Redis/BullMQ singletons) that would otherwise keep the process alive.
    process.exit(0);
  } catch (error) {
    logger.error('[backfillThreadRootThreadId] failed', error);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

export default backfillThreadRootThreadId;
