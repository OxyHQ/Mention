/**
 * One-shot reconciliation: link ALREADY-imported federated replies into their
 * threads.
 *
 * Before the thread-linking fix, federated replies were stored with
 * `federation.inReplyTo` (the raw remote parent URI) but WITHOUT the local
 * `parentPostId` / `threadId` that the thread + replies machinery reads — so an
 * imported reply rendered as an orphan, never attached to its parent.
 *
 * This script finds those orphans (`federation.inReplyTo` set but `parentPostId`
 * unset) and links each one:
 *   - resolve `federation.inReplyTo` → the parent's local Post `_id`
 *     (`parentPostId`),
 *   - derive `threadId` = the thread ROOT id, mirroring the native reply rule
 *     (`threadId = parent.threadId ?? parent._id`), walking UP the chain so every
 *     reply in a thread shares the same root.
 *
 * Resolution reuses `OutboxSyncService.ensureFederatedReplyLink`, the same logic
 * the live ingest paths use. By default it resolves ONLY against parents already
 * present locally (no network I/O). Set `BACKFILL_ANCESTORS=true` to ALSO fetch +
 * import missing ancestor Notes (bounded, signed, SSRF-safe) before linking —
 * this mutates the DB by importing ancestors and is therefore opt-in.
 *
 * Idempotent (re-running skips posts already linked — they no longer match the
 * filter), batched via a stable ascending `_id` cursor, logs progress + a final
 * summary, and supports `DRY_RUN=true` (resolve + report, write nothing; always
 * local-only — never imports ancestors).
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillFederatedThreadLinks.js
 *   DRY_RUN=true bun packages/backend/dist/src/scripts/backfillFederatedThreadLinks.js
 *   BACKFILL_ANCESTORS=true bun packages/backend/dist/src/scripts/backfillFederatedThreadLinks.js
 */

import { and, asc, count, eq, gt, isNotNull, isNull, type SQL } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { findPostRecords } from '../db/posts/postRepository';
import { outboxSyncService } from '../connectors/activitypub/outbox.service';
import { extractInReplyToUri } from '../connectors/activitypub/helpers';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
  registerAdminScriptServices,
} from './lib/adminScriptLifecycle';
import {
  recordRecentReplierForPost,
  type RecentReplyLike,
} from '../services/PostRecentReplierService';

/** Posts scanned per page (stable `id` cursor pagination). */
const PAGE_SIZE = 500;

const DRY_RUN = process.env.DRY_RUN === 'true';
// Opt-in: fetch + import missing ancestor Notes before linking (network I/O,
// mutates the DB). Never active under DRY_RUN.
const BACKFILL_ANCESTORS = !DRY_RUN && process.env.BACKFILL_ANCESTORS === 'true';

async function backfillFederatedThreadLinks(): Promise<void> {
  const startedAt = Date.now();

  try {
    assertAdminMutationAllowed({
      scriptName: 'backfillFederatedThreadLinks',
      dryRun: DRY_RUN,
    });
    await connectPostgres();
    // Reaches `getPostCreator()` through `ensureFederatedReplyLink` →
    // `ensureFederatedNote`, the same call the quoted-post backfill reaches one
    // frame higher — see `registerAdminScriptServices`.
    await registerAdminScriptServices();
    logger.info('[backfillFederatedThreadLinks] connected to PostgreSQL', {
      dryRun: DRY_RUN,
      backfillAncestors: BACKFILL_ANCESTORS,
    });

    // Orphans: a federated reply (has federation.inReplyTo) that was never linked
    // (no parentPostId). The filter set only ever SHRINKS as we set parentPostId,
    // so the ascending `_id` cursor never revisits a linked post.
    // `is not null` / `is null`, never `<> null`: Mongo's `$ne: null` also matched
    // an ABSENT field while SQL's `<>` against NULL matches nothing, so the
    // literal translation would report zero orphans on a corpus full of them.
    const baseFilter = and(
      isNotNull(posts.federationInReplyTo),
      isNull(posts.parentPostId),
    ) as SQL;

    const [totals] = await getDb()
      .select({ count: count() })
      .from(posts)
      .where(baseFilter);
    const totalCount = totals?.count ?? 0;
    logger.info(`[backfillFederatedThreadLinks] ${totalCount} orphan federated replies to scan`);

    if (totalCount === 0) {
      logger.info('[backfillFederatedThreadLinks] nothing to do');
      return;
    }

    let scanned = 0;
    let linked = 0;
    let unresolved = 0;
    let malformed = 0;
    let lastId: string | null = null;
    const db = getDb();
    /**
     * Newly-linked replies whose parent's avatar projection has to learn about
     * them. `post_recent_repliers` has exactly one writer,
     * `recordRecentReplierForPost`, and this script must not become a second
     * one. Fail-soft, per reply, exactly as the live reply paths are.
     */
    const projectionReplies: RecentReplyLike[] = [];

    for (;;) {
      const page = await findPostRecords(
        lastId ? and(baseFilter, gt(posts.id, lastId)) : baseFilter,
        { orderBy: [asc(posts.id)], limit: PAGE_SIZE },
      );

      if (page.length === 0) break;

      for (const post of page) {
        const inReplyToUri = extractInReplyToUri(post.federation?.inReplyTo);
        if (!inReplyToUri) {
          malformed += 1;
          continue;
        }

        const link = await outboxSyncService.ensureFederatedReplyLink(inReplyToUri, {
          allowBackfill: BACKFILL_ANCESTORS,
        });
        if (!link) {
          unresolved += 1;
          continue;
        }

        linked += 1;
        if (!DRY_RUN) {
          // `is_reply` is deliberately NOT written: the row already carries
          // `federation.inReplyTo`, so `derivesReplyIntent` stamped the
          // discriminator at insert. This pass only attaches the LINKS.
          await db
            .update(posts)
            .set({ parentPostId: link.parentPostId, threadId: link.threadId })
            .where(eq(posts.id, post.id));
        }
        if (
          post.oxyUserId &&
          post.visibility === 'public' &&
          post.status === 'published'
        ) {
          projectionReplies.push({
            parentPostId: link.parentPostId,
            oxyUserId: post.oxyUserId,
            createdAt: post.createdAt,
            visibility: post.visibility,
            status: post.status,
          });
        }
      }

      scanned += page.length;
      lastId = page[page.length - 1].id;
      logger.info(
        `[backfillFederatedThreadLinks] progress: scanned ${scanned}/${totalCount}, linked ${linked}, unresolved ${unresolved}, malformed ${malformed}`,
      );
    }

    // The projection is repaired ONCE, after every link has landed: a reply whose
    // parent was itself linked in a later page would otherwise be recorded
    // against a parent that had no children yet.
    if (!DRY_RUN) {
      for (const reply of projectionReplies) {
        await recordRecentReplierForPost(reply);
      }
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillFederatedThreadLinks] done${DRY_RUN ? ' (DRY_RUN — no writes)' : ''}: scanned ${scanned}, linked ${linked}, unresolved ${unresolved}, malformed ${malformed} (${elapsedSeconds}s)`,
    );

    assertAdminRunComplete('backfillFederatedThreadLinks', {
      unresolved,
      malformed,
    });
  } catch (error) {
    logger.error('[backfillFederatedThreadLinks] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (the Redis client and BullMQ
  // handles pulled in through the outbox service) keep the event loop alive, so
  // the Fargate one-shot would sit RUNNING forever after the work completed.
  // Mirrors recomputeFederatedEngagement.
  backfillFederatedThreadLinks()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillFederatedThreadLinks] unhandled failure', error);
      process.exit(1);
    });
}

export default backfillFederatedThreadLinks;
