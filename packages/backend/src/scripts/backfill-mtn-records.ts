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

import mongoose from 'mongoose';
import { Post, type IPost } from '../models/Post';
import MentionSignedRecord from '../models/MentionSignedRecord';
import { MENTION_POST_COLLECTION } from '@mention/shared-types';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';
import { isMentionRecordSigningEnabled } from '../services/mtn/mentionRecordEnv';
import { emitPostCreated } from '../services/mtn/MentionRecordEmitter';
import type { ReplyContext } from '../services/mtn/mentionRecordBuilders';

/** Posts scanned per page (stable `createdAt`/`_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Candidate posts reported per progress line. */
const PROGRESS_EVERY = 500;

const DRY_RUN = process.env.DRY_RUN === 'true';

/** Minimal post projection the backfill needs to build + emit a record. */
interface CandidateRow {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
}

/**
 * Resolve the reply context (root/parent post ids + their OWNER oxyUserIds) for a
 * reply post, MIRRORING `PostCreationService.emitMtnRecord` so a backfilled reply
 * record matches the live path exactly. Returns `undefined` for a top-level post
 * or when an owner cannot be resolved (the post then emits as a top-level record,
 * same as the live path's guard).
 */
async function resolveReplyContext(post: IPost): Promise<ReplyContext | undefined> {
  if (!post.parentPostId) return undefined;
  const rootId = post.threadId ?? post.parentPostId;
  const ids = [...new Set([post.parentPostId, rootId])];
  const refs = await Post.find({ _id: { $in: ids } }).select('oxyUserId').lean();
  const ownerById = new Map(refs.map((r) => [String(r._id), r.oxyUserId]));
  const parentOwner = ownerById.get(String(post.parentPostId));
  const rootOwner = ownerById.get(String(rootId));
  if (parentOwner && rootOwner) {
    return {
      root: { postId: String(rootId), oxyUserId: rootOwner },
      parent: { postId: String(post.parentPostId), oxyUserId: parentOwner },
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
  const existing = await MentionSignedRecord.find(
    { nsid: MENTION_POST_COLLECTION, rkey: { $in: postIds } },
    { rkey: 1 },
  ).lean<Array<{ rkey?: string }>>();
  return new Set(existing.map((r) => r.rkey).filter((r): r is string => typeof r === 'string'));
}

async function backfillMtnRecords(): Promise<void> {
  const startedAt = Date.now();

  await connectToDatabase();
  logger.info(`[backfill-mtn-records] connected to MongoDB; DRY_RUN=${DRY_RUN}`);

  // INERT-SAFE: never fabricate unsigned records. Bail up front when signing is
  // unconfigured so a re-run with the env set later does the real work.
  if (!isMentionRecordSigningEnabled()) {
    logger.info('[backfill-mtn-records] MTN signing disabled (MENTION_DID/keys unset); no-op');
    return;
  }

  // The local, public, published, non-boost post set. `boostOf` excludes boosts (which are
  // `app.mention.feed.repost` records, out of scope). The filter is immutable for
  // this run (we never mutate the fields it selects on), so the cursor is stable.
  const candidateFilter: Record<string, unknown> = {
    'federation.activityId': { $exists: false },
    oxyUserId: { $exists: true, $ne: null },
    boostOf: { $exists: false },
    status: 'published',
    visibility: 'public',
  };

  const totalCount = await Post.countDocuments(candidateFilter);
  logger.info(`[backfill-mtn-records] ${totalCount} local public published non-boost posts to scan`);

  if (totalCount === 0) {
    logger.info('[backfill-mtn-records] nothing to do');
    return;
  }

  let scanned = 0;
  let emitted = 0;
  let skippedExisting = 0;
  let failed = 0;
  // Cursor by (createdAt, _id) ascending so a user's posts are appended in
  // creation order (genesis = oldest). `_id` breaks createdAt ties stably.
  let cursor: { createdAt: Date; id: mongoose.Types.ObjectId } | null = null;

  for (;;) {
    const pageFilter: Record<string, unknown> = { ...candidateFilter };
    if (cursor) {
      pageFilter.$or = [
        { createdAt: { $gt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $gt: cursor.id } },
      ];
    }

    const page = await Post.find(pageFilter, { _id: 1, createdAt: 1 })
      .sort({ createdAt: 1, _id: 1 })
      .limit(PAGE_SIZE)
      .lean<CandidateRow[]>();

    if (page.length === 0) break;

    const pageIds = page.map((p) => p._id.toString());
    const idsWithRecord = await findPostIdsWithRecord(pageIds);

    for (const row of page) {
      const postId = row._id.toString();
      if (idsWithRecord.has(postId)) {
        skippedExisting += 1;
        continue;
      }

      if (DRY_RUN) {
        emitted += 1;
        continue;
      }

      // Load the full post so the builder has its text/tags/langs/sources/etc.
      const post = await Post.findById(row._id);
      if (!post) {
        // Raced away between the page read and now — skip.
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
        const wrote = await MentionSignedRecord.exists({
          nsid: MENTION_POST_COLLECTION,
          rkey: postId,
        });
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
    cursor = { createdAt: last.createdAt, id: last._id };

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
}

async function run(): Promise<void> {
  try {
    await backfillMtnRecords();
    await mongoose.disconnect();
    // Exit explicitly: imported model/service modules may hold open handles
    // (Redis/BullMQ singletons) that would otherwise keep the process alive.
    process.exit(0);
  } catch (error) {
    logger.error('[backfill-mtn-records] failed', error);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  }
}

if (require.main === module) {
  run();
}

export default backfillMtnRecords;
