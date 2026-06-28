/**
 * One-shot backfill: repopulate cached link previews for YouTube posts.
 *
 * YouTube `watch` pages serve their Open Graph tags ~630 KB into the document,
 * past the metadata reader's old 512 KB cap, so the live preview warm resolved a
 * hostname-only fallback (title = "www.youtube.com", no image/description) and
 * persisted THAT stale entry in the Redis preview cache. The reader is now fixed
 * (reads to `</head>`), but already-cached YouTube previews remain stale until
 * their TTL expires.
 *
 * This script finds posts whose text references YouTube, computes the SAME first
 * URL the live preview path uses ({@link PostHydrationService.extractFirstUrl}),
 * keeps only canonical YouTube hosts, de-dupes, and re-resolves each URL through
 * the (now-fixed) `linkMetadataService`, overwriting the stale cache entry via
 * `storePreview` (or recording `markNoPreview` when the page yields nothing). It
 * mirrors `PostHydrationService.warmLinkPreviews`: it runs off any response path,
 * awaits the image downscale so the optimized CDN image is persisted, and caps
 * concurrency so a burst of fetches can't overwhelm outbound bandwidth.
 *
 * Idempotent (re-running re-resolves and re-stores; correct previews stay
 * correct), batched via a stable ascending `_id` cursor, logs progress plus a
 * final summary.
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillYoutubeLinkPreviews.js
 */

import mongoose from 'mongoose';
import type { PostLinkPreview } from '@mention/shared-types';
import { Post } from '../models/Post';
import { linkMetadataService } from '../services/linkMetadataService';
import { storePreview, markNoPreview } from '../services/linkPreviewCache';
import { getRedisClient, closeRedisConnection } from '../utils/redis';
import { logger } from '../utils/logger';

/** Posts scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Remote fetches run in parallel — mirrors `warmLinkPreviews` WARM_CONCURRENCY. */
const FETCH_CONCURRENCY = 5;

/** Matches any post text that references a YouTube URL (drives the Mongo scan). */
const YOUTUBE_TEXT_MATCH = /(youtube\.com|youtu\.be)/i;

/** Canonical YouTube hosts a first-URL preview is worth re-resolving for. */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);

interface YoutubePostRow {
  _id: mongoose.Types.ObjectId;
  content?: { text?: string };
}

/**
 * Extract the FIRST URL from post text, identical to
 * {@link PostHydrationService.extractFirstUrl}: the live preview only ever uses
 * the first URL, so the backfill must too.
 */
function extractFirstUrl(text: string): string | null {
  if (!text) return null;
  const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(text)) !== null) {
    if (!match[0]) continue;
    let url = match[0];
    while (/[.,!?):;\]]$/.test(url)) {
      url = url.slice(0, -1);
    }
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    try {
      new URL(url);
      return url;
    } catch {
      continue;
    }
  }
  return null;
}

/** Whether a URL points at a canonical YouTube host. */
function isYoutubeUrl(url: string): boolean {
  try {
    return YOUTUBE_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Re-resolve a single URL and overwrite its cached preview. Returns whether a
 * usable preview was stored (`true`) or the URL was marked as no-preview
 * (`false`) — including on fetch failure, mirroring the live warm path.
 */
async function repopulate(url: string): Promise<boolean> {
  try {
    // Off the response path: AWAIT the image downscale so the persisted preview
    // serves the optimized CDN image (not the raw full-res og:image).
    const metadata = await linkMetadataService.fetchMetadata(url, { awaitImageCache: true });
    const hasContent = Boolean(metadata.title || metadata.description || metadata.image);
    if (!hasContent) {
      await markNoPreview(url);
      return false;
    }
    const preview: PostLinkPreview = {
      url: metadata.url,
      title: metadata.title || undefined,
      description: metadata.description || undefined,
      image: metadata.image || undefined,
      siteName: metadata.siteName || undefined,
    };
    await storePreview(url, preview);
    return true;
  } catch (error) {
    await markNoPreview(url);
    logger.warn('[backfillYoutubeLinkPreviews] failed to resolve preview', {
      url,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
}

async function backfillYoutubeLinkPreviews(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(`[backfillYoutubeLinkPreviews] connected to MongoDB (${dbName})`);

    // Kick off the Redis connection up front; preview writes degrade to no-ops
    // if Redis is unavailable (no REDIS_URL).
    getRedisClient();

    const baseFilter = { 'content.text': { $regex: YOUTUBE_TEXT_MATCH } };

    const totalCount = await Post.countDocuments(baseFilter);
    logger.info(`[backfillYoutubeLinkPreviews] ${totalCount} posts reference YouTube`);

    if (totalCount === 0) {
      logger.info('[backfillYoutubeLinkPreviews] nothing to do');
      await mongoose.disconnect();
      await closeRedisConnection();
      return;
    }

    // Collect the unique set of canonical YouTube first-URLs across all posts.
    // The live preview only resolves the FIRST URL, so we mirror that exactly.
    const uniqueUrls = new Set<string>();
    let scanned = 0;
    let matched = 0;
    let lastId: mongoose.Types.ObjectId | null = null;

    for (;;) {
      const pageFilter: Record<string, unknown> = { ...baseFilter };
      if (lastId) {
        pageFilter._id = { $gt: lastId };
      }

      const page = await Post.find(pageFilter, { _id: 1, 'content.text': 1 })
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean<YoutubePostRow[]>();

      if (page.length === 0) break;

      for (const post of page) {
        const text = post.content?.text;
        if (!text) continue;
        const url = extractFirstUrl(text);
        if (!url || !isYoutubeUrl(url)) continue;
        matched += 1;
        uniqueUrls.add(url);
      }

      scanned += page.length;
      lastId = page[page.length - 1]._id;
      logger.info(
        `[backfillYoutubeLinkPreviews] scanned ${scanned}/${totalCount}, matched ${matched}, unique urls ${uniqueUrls.size}`,
      );
    }

    const urls = Array.from(uniqueUrls);
    logger.info(
      `[backfillYoutubeLinkPreviews] resolving ${urls.length} unique YouTube urls (concurrency ${FETCH_CONCURRENCY})`,
    );

    let repopulated = 0;
    let skippedNoContent = 0;

    for (let i = 0; i < urls.length; i += FETCH_CONCURRENCY) {
      const batch = urls.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.all(batch.map((url) => repopulate(url)));
      for (const stored of results) {
        if (stored) repopulated += 1;
        else skippedNoContent += 1;
      }
      logger.info(
        `[backfillYoutubeLinkPreviews] progress: resolved ${Math.min(i + batch.length, urls.length)}/${urls.length}, repopulated ${repopulated}, skipped ${skippedNoContent}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillYoutubeLinkPreviews] done: scanned ${scanned}, matched ${matched}, unique ${urls.length}, repopulated ${repopulated}, skipped(no-content) ${skippedNoContent} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
    await closeRedisConnection();
  } catch (error) {
    logger.error('[backfillYoutubeLinkPreviews] failed', error);
    await mongoose.disconnect();
    await closeRedisConnection();
    process.exit(1);
  }
}

if (require.main === module) {
  backfillYoutubeLinkPreviews();
}

export default backfillYoutubeLinkPreviews;
