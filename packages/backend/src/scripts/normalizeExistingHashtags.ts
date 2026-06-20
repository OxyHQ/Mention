/**
 * One-shot reconciliation: re-normalize existing hashtag data so it matches the
 * canonical recipe enforced on write by `normalizeHashtag`
 * (`packages/backend/src/utils/textProcessing.ts`).
 *
 * Background: before the disallowed-char fix, `normalizeHashtag` only stripped a
 * leading `#`, trimmed, and lowercased — so internal spaces and other junk
 * characters survived into stored data (e.g. a tag literally stored as
 * `"the village and the hills"`). The fix now also removes every char that is
 * not a unicode letter/number/underscore, collapsing such values into a single
 * Mastodon-style token (`thevillageandthehills`). Documents written before the
 * fix still carry the bad values; this script rewrites them.
 *
 * Two phases, both idempotent and safe to run twice:
 *
 *   Phase 1 — Posts: scan every post whose `hashtags` array contains at least
 *   one element with a disallowed character, re-run `normalizePostHashtags`
 *   (which dedupes and drops empties), and write back the cleaned `hashtags`
 *   (and the cleaned `content.text`, which the same normalizer produces). Posts
 *   whose tags are already canonical are never matched, so re-running is a no-op.
 *
 *   Phase 2 — Hashtag collection: the `Hashtag` collection (`{ name, count }`,
 *   `name` UNIQUE) is a denormalized search/trending index. After Phase 1 the
 *   authoritative per-tag post counts are recomputed directly from
 *   `Post.hashtags` via aggregation, then reconciled into the collection:
 *   names that no longer exist are deleted, counts are upserted to match. Because
 *   the authoritative counts are aggregated AFTER normalization, two old names
 *   that collapse to the same normalized name (e.g. `"New York"` and `"newyork"`)
 *   merge into ONE row with the summed count — the unique-`name` constraint is
 *   honoured because we upsert the single normalized key, and the stale
 *   non-canonical rows are removed in the same pass.
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/normalizeExistingHashtags.js
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import Hashtag from '../models/Hashtag';
import { normalizePostHashtags, normalizeHashtag } from '../utils/textProcessing';
import { logger } from '../utils/logger';

/** Posts scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Writes flushed per bulkWrite chunk. */
const BULK_CHUNK_SIZE = 500;

/**
 * Mongo `$regex` that matches a hashtag string containing at least one char that
 * is NOT a unicode letter/number/underscore — i.e. a tag that the current
 * `normalizeHashtag` would rewrite. Mirrors the disallowed-char class used by
 * the util; kept as a raw pattern string because Mongo compiles it server-side.
 *
 * `\p{...}` unicode property escapes require PCRE; MongoDB's `$regex` uses PCRE
 * and supports them, so this is evaluated entirely in the database.
 */
const DISALLOWED_CHAR_REGEX = '[^\\p{L}\\p{N}_]';

interface PostRow {
  _id: mongoose.Types.ObjectId;
  content?: { text?: string };
  hashtags?: string[];
}

/** True when re-normalizing would change the stored hashtags array. */
function hashtagsNeedRewrite(current: string[], next: string[]): boolean {
  if (current.length !== next.length) return true;
  for (let i = 0; i < current.length; i += 1) {
    if (current[i] !== next[i]) return true;
  }
  return false;
}

/**
 * Phase 1: re-normalize `Post.hashtags` (and `content.text`) for every post that
 * still carries a non-canonical tag. Returns the number of posts rewritten.
 */
async function renormalizePosts(): Promise<number> {
  const pageFilterBase: Record<string, unknown> = {
    hashtags: { $elemMatch: { $regex: DISALLOWED_CHAR_REGEX } },
  };

  const totalCount = await Post.countDocuments(pageFilterBase);
  logger.info(`[normalizeExistingHashtags] phase 1: ${totalCount} posts with non-canonical hashtags`);

  if (totalCount === 0) return 0;

  let scanned = 0;
  let rewritten = 0;
  let lastId: mongoose.Types.ObjectId | null = null;
  let pendingOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];

  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0) return;
    const result = await Post.bulkWrite(pendingOps, { ordered: false });
    rewritten += result.modifiedCount;
    pendingOps = [];
  };

  for (;;) {
    const pageFilter: Record<string, unknown> = { ...pageFilterBase };
    if (lastId) {
      pageFilter._id = { $gt: lastId };
    }

    const page = await Post.find(pageFilter, { _id: 1, 'content.text': 1, hashtags: 1 })
      .sort({ _id: 1 })
      .limit(PAGE_SIZE)
      .lean<PostRow[]>();

    if (page.length === 0) break;

    for (const post of page) {
      const currentHashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
      // Re-run the centralized normalizer. Pass the existing tags as
      // userProvided so tags without an inline `#` token in the text survive the
      // rewrite; the normalizer collapses disallowed chars, dedupes, and drops
      // empties.
      const { content, hashtags } = normalizePostHashtags(post.content?.text, currentHashtags);

      if (hashtagsNeedRewrite(currentHashtags, hashtags)) {
        pendingOps.push({
          updateOne: {
            filter: { _id: post._id },
            update: {
              $set: {
                hashtags,
                'content.text': content,
              },
            },
          },
        });
      }

      if (pendingOps.length >= BULK_CHUNK_SIZE) {
        await flush();
      }
    }

    scanned += page.length;
    lastId = page[page.length - 1]._id;
    logger.info(
      `[normalizeExistingHashtags] phase 1 progress: scanned ${scanned}/${totalCount}, rewritten ${rewritten}`,
    );
  }

  await flush();
  logger.info(`[normalizeExistingHashtags] phase 1 done: rewrote ${rewritten} posts`);
  return rewritten;
}

/**
 * Phase 2: rebuild the `Hashtag` collection (`{ name, count }`) authoritatively
 * from the (now-canonical) `Post.hashtags`. Returns a summary of the reconcile.
 */
async function reconcileHashtagCollection(): Promise<{ upserted: number; deleted: number }> {
  logger.info('[normalizeExistingHashtags] phase 2: recomputing Hashtag counts from posts');

  // Authoritative counts: one row per distinct tag across all posts. Defensive
  // re-normalize via $function-free JS pass below in case any residual
  // non-canonical tag slipped through (it shouldn't after phase 1, but the
  // collection rebuild must never resurrect a bad name).
  const rawCounts = await Post.aggregate<{ _id: string; count: number }>([
    { $match: { hashtags: { $exists: true, $type: 'array', $ne: [] } } },
    { $unwind: '$hashtags' },
    { $group: { _id: '$hashtags', count: { $sum: 1 } } },
  ]);

  // Merge any names that collapse to the same canonical form (handles residual
  // bad data and guarantees no duplicate target key before we upsert against the
  // unique `name` index).
  const authoritative = new Map<string, number>();
  for (const row of rawCounts) {
    const name = normalizeHashtag(typeof row._id === 'string' ? row._id : '');
    if (!name) continue;
    authoritative.set(name, (authoritative.get(name) ?? 0) + row.count);
  }
  logger.info(`[normalizeExistingHashtags] phase 2: ${authoritative.size} distinct canonical tags`);

  // Upsert authoritative counts.
  let upserted = 0;
  let pendingUpserts: mongoose.AnyBulkWriteOperation<typeof Hashtag>[] = [];
  const flushUpserts = async (): Promise<void> => {
    if (pendingUpserts.length === 0) return;
    await Hashtag.bulkWrite(pendingUpserts, { ordered: false });
    pendingUpserts = [];
  };

  for (const [name, count] of authoritative) {
    pendingUpserts.push({
      updateOne: {
        filter: { name },
        update: { $set: { count } },
        upsert: true,
      },
    });
    upserted += 1;
    if (pendingUpserts.length >= BULK_CHUNK_SIZE) {
      await flushUpserts();
    }
  }
  await flushUpserts();

  // Delete any rows whose name is no longer authoritative (stale non-canonical
  // names left over from before the fix, and tags no longer used by any post).
  const staleNames: string[] = [];
  const cursor = Hashtag.find({}, { name: 1 }).lean<{ name: string }[]>().cursor();
  for await (const doc of cursor) {
    if (!authoritative.has(doc.name)) {
      staleNames.push(doc.name);
    }
  }

  let deleted = 0;
  if (staleNames.length > 0) {
    const result = await Hashtag.deleteMany({ name: { $in: staleNames } });
    deleted = result.deletedCount ?? 0;
  }

  logger.info(`[normalizeExistingHashtags] phase 2 done: upserted ${upserted} counts, deleted ${deleted} stale rows`);
  return { upserted, deleted };
}

async function normalizeExistingHashtags(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(`[normalizeExistingHashtags] connected to MongoDB (${dbName})`);

    const postsRewritten = await renormalizePosts();
    const { upserted, deleted } = await reconcileHashtagCollection();

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[normalizeExistingHashtags] done: rewrote ${postsRewritten} posts, ` +
        `reconciled ${upserted} hashtag rows, deleted ${deleted} stale rows (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[normalizeExistingHashtags] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  normalizeExistingHashtags();
}

export default normalizeExistingHashtags;
