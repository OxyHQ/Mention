/**
 * One-shot backfill: emit a signed genesis-chain `app.mention.feed.post` record
 * for every existing LOCAL-authored post that does not yet have one.
 *
 * The MTN dual-write (`MentionRecordEmitter`) only signs records for posts
 * created AFTER it shipped. This script walks the existing corpus and appends the
 * missing records so every local post's chain is complete — a prerequisite for
 * the later (B3) source-of-truth pivot and node ingest.
 *
 * SCOPE: `app.mention.feed.post` records only. A post QUALIFIES iff:
 *   - it is LOCAL-authored: `federation == null && oxyUserId` set (federated
 *     posts belong to the origin instance and never emit a Mention record), and
 *   - it is published and public (draft/private posts must never appear on the
 *     public atproto bridge), and
 *   - it is NOT a boost (`type: 'boost'` / `boostOf` set) — boosts are
 *     `app.mention.feed.repost` records, a different collection, intentionally
 *     out of scope here so this backfill stays idempotent (a boost would never
 *     have a POST record and would otherwise be re-processed on every run), and
 *   - it has NO existing `app.mention.feed.post` record:
 *     no `MentionSignedRecord { oxyUserId, nsid: <post collection>, rkey: <_id> }`.
 *
 * ORDERING: posts are processed OLDEST-FIRST (`createdAt` ascending, `_id` as the
 * stable tiebreak). `signAndAppend` reads the chain head and appends `seq = head
 * + 1`, so per user the oldest post becomes genesis `seq: 0` and the chain grows
 * in creation order — a sensible, deterministic chain. Emission is SERIAL (one
 * post at a time) so each append sees the prior append's head; concurrent appends
 * would contend on the per-(oxyUserId, seq) unique index.
 *
 * INERT-SAFE: when MTN custodial signing is unconfigured
 * (`isMentionRecordSigningEnabled() === false`), the script is a logged NO-OP and
 * exits 0 WITHOUT fabricating any unsigned records (it never writes an
 * unsigned/forged record — that is the whole point of the chain).
 *
 * IDEMPOTENT: a re-run skips every post that already has a record (the existence
 * check), so only genuinely-missing records are emitted. The reply-context
 * resolution mirrors `PostCreationService.emitMtnRecord` so a backfilled reply
 * record is byte-identical to one the live path would have emitted.
 *
 * It does NOT run automatically (no scheduler wiring) — a manual Fargate one-shot:
 *   DRY_RUN=true bun packages/backend/dist/src/scripts/backfill-mtn-records.js
 *   bun packages/backend/dist/src/scripts/backfill-mtn-records.js
 */

import { and, asc, count, eq, gt, inArray, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import { posts } from '../db/schema/posts';
import { findPostRecords, loadPostRecords } from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import { connectPostgres, getDb } from '../db/postgres';
import { mentionSignedRecords } from '../db/schema/mtn';
import { MENTION_POST_COLLECTION, PostVisibility } from '@mention/shared-types';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { isMentionRecordSigningEnabled } from '../services/mtn/mentionRecordEnv';
import { emitPostCreated } from '../services/mtn/MentionRecordEmitter';
import type { ReplyContext } from '../services/mtn/mentionRecordBuilders';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';

/** Posts scanned per page (stable `createdAt`/`_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Candidate posts reported per progress line. */
const PROGRESS_EVERY = 500;

const DRY_RUN = process.env.DRY_RUN === 'true';

/**
 * Resolve the reply context (root/parent post ids + their OWNER oxyUserIds) for a
 * reply post, MIRRORING `PostCreationService.emitMtnRecord` so a backfilled reply
 * record matches the live path exactly. Returns `undefined` for a top-level post
 * or when an owner cannot be resolved (the post then emits as a top-level record,
 * same as the live path's guard).
 */
async function resolveReplyContext(post: PostRecord): Promise<ReplyContext | undefined> {
  if (!post.parentPostId) return undefined;
  const rootId = post.threadId ?? post.parentPostId;
  const ids = [...new Set([post.parentPostId, rootId])];
  const refs = await loadPostRecords(ids);
  const ownerById = new Map(refs.map((r) => [r.id, r.oxyUserId]));
  const parentOwner = ownerById.get(post.parentPostId);
  const rootOwner = ownerById.get(rootId);
  if (parentOwner && rootOwner) {
    return {
      root: { postId: rootId, oxyUserId: rootOwner },
      parent: { postId: post.parentPostId, oxyUserId: parentOwner },
    };
  }
  return undefined;
}

/**
 * Return the set of post ids (string `_id`s) in `postIds` that ALREADY have an
 * `app.mention.feed.post` record, in one batched query. The remaining ids are the
 * ones that need a record emitted.
 */
async function findPostIdsWithRecord(postIds: string[]): Promise<Set<string>> {
  if (postIds.length === 0) return new Set();
  // `inArray`, never a JS array interpolated into `sql` — a raw array binds as a
  // ROW constructor and `= any(<row>)` is a type error, not a match.
  const existing = await getDb()
    .select({ rkey: mentionSignedRecords.rkey })
    .from(mentionSignedRecords)
    .where(
      and(
        eq(mentionSignedRecords.nsid, MENTION_POST_COLLECTION),
        inArray(mentionSignedRecords.rkey, postIds),
      ),
    );
  return new Set(existing.map((r) => r.rkey).filter((r): r is string => typeof r === 'string'));
}

async function backfillMtnRecords(): Promise<void> {
  const startedAt = Date.now();

  assertAdminMutationAllowed({
    scriptName: 'backfillMtnRecords',
    dryRun: DRY_RUN,
  });
  await connectPostgres();
  logger.info(`[backfill-mtn-records] connected to PostgreSQL; DRY_RUN=${DRY_RUN}`);

  // INERT-SAFE: never fabricate unsigned records. Bail up front when signing is
  // unconfigured so a re-run with the env set later does the real work.
  if (!isMentionRecordSigningEnabled()) {
    logger.info('[backfill-mtn-records] MTN signing disabled (MENTION_DID/keys unset); no-op');
    return;
  }

  // The local, non-boost post set. `boostOf` excludes boosts (which are
  // `app.mention.feed.repost` records, out of scope). The filter is immutable for
  // this run (we never mutate the columns it selects on), so the cursor is stable.
  //
  // Every arm is `IS NULL` / `IS NOT NULL` rather than `<> null`: Mongo's
  // `$exists: false` and `$ne: null` both matched an ABSENT field, while SQL's
  // `<>` against NULL evaluates to NULL and matches nothing — the literal
  // translation would select zero candidates and report a clean no-op run.
  const candidateFilter = and(
    isNull(posts.federationActivityId),
    isNotNull(posts.oxyUserId),
    eq(posts.status, 'published'),
    eq(posts.visibility, PostVisibility.PUBLIC),
    isNull(posts.boostOf),
  ) as SQL;

  const [totals] = await getDb()
    .select({ count: count() })
    .from(posts)
    .where(candidateFilter);
  const totalCount = totals?.count ?? 0;
  logger.info(`[backfill-mtn-records] ${totalCount} local non-boost posts to scan`);

  if (totalCount === 0) {
    logger.info('[backfill-mtn-records] nothing to do');
    return;
  }

  let scanned = 0;
  let emitted = 0;
  let skippedExisting = 0;
  let failed = 0;
  // Cursor by (createdAt, id) ascending so a user's posts are appended in
  // creation order (genesis = oldest). `id` breaks createdAt ties stably.
  let cursor: { createdAt: Date; id: string } | null = null;

  for (;;) {
    // The page carries the WHOLE record, not a projection: the builder needs the
    // post's text, tags, langs and sources anyway, and a nine-table assembly for
    // a page of 500 is one batched read per child table — cheaper than the
    // per-post re-fetch the projection forced.
    const page = await findPostRecords(
      cursor
        ? and(
          candidateFilter,
          or(
            gt(posts.createdAt, cursor.createdAt),
            and(eq(posts.createdAt, cursor.createdAt), gt(posts.id, cursor.id)),
          ),
        )
        : candidateFilter,
      { orderBy: [asc(posts.createdAt), asc(posts.id)], limit: PAGE_SIZE },
    );

    if (page.length === 0) break;

    const pageIds = page.map((p) => p.id);
    const idsWithRecord = await findPostIdsWithRecord(pageIds);

    for (const post of page) {
      const postId = post.id;
      if (idsWithRecord.has(postId)) {
        skippedExisting += 1;
        continue;
      }

      if (DRY_RUN) {
        emitted += 1;
        continue;
      }

      try {
        const reply = await resolveReplyContext(post);
        // `emitPostCreated` is gated on a local author (which the filter already
        // guarantees) and isolates its own failures; it reuses the existing
        // builder so the record is identical to a live-path emission.
        await emitPostCreated(post, { reply });
        // Confirm the record landed (the emitter swallows append failures). A
        // present record on re-query means the append succeeded.
        const [wrote] = await getDb()
          .select({ id: mentionSignedRecords.id })
          .from(mentionSignedRecords)
          .where(
            and(
              eq(mentionSignedRecords.nsid, MENTION_POST_COLLECTION),
              eq(mentionSignedRecords.rkey, postId),
            ),
          )
          .limit(1);
        if (wrote) {
          emitted += 1;
        } else {
          failed += 1;
        }
      } catch (error) {
        failed += 1;
        logger.warn('[backfill-mtn-records] failed to emit record for post', {
          postId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    scanned += page.length;
    const last = page[page.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };

    if (scanned % PROGRESS_EVERY === 0 || scanned >= totalCount) {
      logger.info(
        `[backfill-mtn-records] progress: scanned ${scanned}/${totalCount}, ` +
          `emitted ${emitted}, skipped (existing) ${skippedExisting}, failed ${failed}`,
      );
    }
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  logger.info(
    `[backfill-mtn-records] done${DRY_RUN ? ' (DRY_RUN — no records written)' : ''}: ` +
      `scanned ${scanned}, ${DRY_RUN ? 'would emit' : 'emitted'} ${emitted}, ` +
      `skipped (existing) ${skippedExisting}, failed ${failed} (${elapsedSeconds}s)`,
  );

  assertAdminRunComplete('backfillMtnRecords', { failed });
}

async function run(): Promise<void> {
  let exitCode = 0;
  try {
    await backfillMtnRecords();
  } catch (error) {
    logger.error('[backfill-mtn-records] failed', error);
    exitCode = 1;
  } finally {
    await closeAdminScriptResources().catch((error) => {
      logger.error('[backfill-mtn-records] resource cleanup failed', error);
      exitCode = 1;
    });
  }
  process.exit(exitCode);
}

if (require.main === module) {
  run();
}

export default backfillMtnRecords;
