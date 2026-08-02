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

import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

/**
 * A thread needs 2+ continuations to be a broken fan worth repairing. A thread
 * with a single continuation is already a correct chain (that one continuation
 * correctly replies to the root).
 */
const MIN_CONTINUATIONS_FOR_REPAIR = 2;

/** Root posts fetched per `$in` chunk when verifying thread ownership. */
const ROOT_FETCH_CHUNK_SIZE = 500;

/** Candidate threads reported per progress line. */
const PROGRESS_EVERY = 500;

const DRY_RUN = process.env.DRY_RUN === 'true';

/** One continuation of a candidate thread, as collected by the aggregation. */
interface ContinuationRow {
  id: string;
  parentPostId: string | null;
  createdAt: Date;
}

/** A candidate broken-fan thread group from the aggregation. */
interface CandidateThreadGroup {
  /** The shared `threadId` (the root post's id, as a string). */
  _id: string;
  count: number;
  authors: string[];
  continuations: ContinuationRow[];
}

/**
 * Find candidate broken-fan threads: NATIVE, single-author, pure-fan groups (every
 * member's `parentPostId === threadId`) with 2+ continuations. Root ownership is
 * verified separately. Already-chained or partially-chained threads are not pure
 * fans, so the query never returns them (idempotency at the source).
 */
async function loadCandidateGroups(): Promise<CandidateThreadGroup[]> {
  const rows = await getDb()
    .select({
      threadId: posts.threadId,
      count: sql<number>`count(*)::int`,
      authors: sql<string[]>`array_agg(distinct ${posts.oxyUserId})`,
      // Members whose parent does NOT point at the root — i.e. already chained.
      // A genuine broken fan has zero of these.
      nonFanCount: sql<number>`count(*) filter (
        where ${posts.parentPostId} is distinct from ${posts.threadId}
      )::int`,
      continuations: sql<ContinuationRow[]>`json_agg(json_build_object(
        'id', ${posts.id},
        'parentPostId', ${posts.parentPostId},
        'createdAt', ${posts.createdAt}
      ))`,
    })
    .from(posts)
    .where(and(
      // `is not null`, never `<> null`: `$ne: null` matched a MISSING field too,
      // while SQL's `<>` against NULL matches nothing.
      isNotNull(posts.threadId),
      // Native posts only — federated posts carry a federation activity id.
      isNull(posts.federationActivityId),
    ))
    .groupBy(posts.threadId)
    .having(sql`count(*) >= ${MIN_CONTINUATIONS_FOR_REPAIR}
      and count(*) filter (where ${posts.parentPostId} is distinct from ${posts.threadId}) = 0
      and count(distinct ${posts.oxyUserId}) = 1`);

  return rows.flatMap((row) =>
    row.threadId
      ? [{
        _id: row.threadId,
        count: row.count,
        authors: row.authors,
        continuations: row.continuations.map((entry) => ({
          ...entry,
          createdAt: new Date(entry.createdAt),
        })),
      }]
      : [],
  );
}

/**
 * Batch-fetch the root posts (`_id === threadId`) for the candidate threads and
 * return a map of rootId string -> author oxyUserId, restricted to NATIVE roots.
 * Threads whose root is missing, federated, or absent from this map fail ownership
 * verification and are skipped.
 */
async function loadRootAuthors(threadIds: string[]): Promise<Map<string, string | null>> {
  const rootAuthorById = new Map<string, string | null>();
  // No id-shape filter: `posts.id` is `text`, so an id of any shape is a
  // parameter that matches no row.
  for (let i = 0; i < threadIds.length; i += ROOT_FETCH_CHUNK_SIZE) {
    const chunk = threadIds.slice(i, i + ROOT_FETCH_CHUNK_SIZE);
    const roots = await getDb()
      .select({ id: posts.id, oxyUserId: posts.oxyUserId })
      .from(posts)
      .where(and(inArray(posts.id, chunk), isNull(posts.federationActivityId)));
    for (const root of roots) {
      rootAuthorById.set(root.id, root.oxyUserId);
    }
  }

  return rootAuthorById;
}

/**
 * Creation order, by `created_at` with the id as a stable tiebreak.
 *
 * NOT by id. The previous sort relied on "ascending ObjectId hex compares as
 * creation order", which was true of ObjectIds and is not true of `posts.id`:
 * it holds a 24-char ObjectId hex for pre-cutover rows and a uuid v7 after, and
 * the two spaces interleave under text collation (`'0' < '6'`). A thread with
 * members on both sides of the cutover would be re-chained in the wrong order —
 * which is the exact defect this script exists to repair, reintroduced by the
 * repair itself.
 */
function byCreationOrder(a: ContinuationRow, b: ContinuationRow): number {
  const delta = a.createdAt.getTime() - b.createdAt.getTime();
  if (delta !== 0) return delta;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

async function migrateThreadFanToChain(): Promise<void> {
  assertAdminMutationAllowed({
    scriptName: 'migrateThreadFanToChain',
    dryRun: DRY_RUN,
  });
  const startedAt = Date.now();

  await connectPostgres();
  logger.info(`[migrateThreadFanToChain] connected to PostgreSQL; DRY_RUN=${DRY_RUN}`);

  const candidates = await loadCandidateGroups();
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

  for (const group of candidates) {
    threadsScanned += 1;
    const threadId = group._id;
    const author = group.authors[0];

    // Ownership: the root (_id === threadId) must exist, be native, and be authored
    // by the SAME single author as the continuations. Excludes "user replied to
    // someone else's post N times" and missing/federated roots.
    const rootAuthor = rootAuthorById.get(threadId);
    if (rootAuthor == null || rootAuthor !== author) {
      threadsSkippedOwnership += 1;
      continue;
    }

    const continuations = [...group.continuations].sort(byCreationOrder);

    let threadHasRelink = false;
    for (let k = 0; k < continuations.length; k++) {
      const current = continuations[k];
      // First continuation correctly replies to the root; each subsequent one
      // should reply to the immediately-previous continuation.
      const correctParent = k === 0 ? threadId : continuations[k - 1].id;

      // Idempotent: only write posts whose parentPostId is wrong. (For an
      // untouched fan this is exactly continuations[1..n-1].)
      if (current.parentPostId === correctParent) continue;

      threadHasRelink = true;
      postsRelinkPlanned += 1;
      if (!DRY_RUN) {
        const relinked = await getDb()
          .update(posts)
          .set({ parentPostId: correctParent })
          .where(eq(posts.id, current.id))
          .returning({ id: posts.id });
        postsRelinkWritten += relinked.length;
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
    await closeAdminScriptResources();
    // Exit explicitly: imported model/service modules may hold open handles
    // (Redis/BullMQ singletons) that would otherwise keep the process alive.
    process.exit(0);
  } catch (error) {
    logger.error('[migrateThreadFanToChain] failed', error);
    await closeAdminScriptResources().catch(() => undefined);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

export default migrateThreadFanToChain;
