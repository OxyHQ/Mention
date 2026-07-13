/**
 * One-shot cleanup: re-ingest (or delete) federated posts that were stored with
 * an EMPTY body by the pre-fix ingest paths.
 *
 * Both federated ingest paths (inbox `Create`, outbox backfill) used to build the
 * post body from `object.content` ONLY — with no `contentMap` fallback and no
 * empty-note guard. As a result:
 *   - a Mastodon status whose visible text lived in a `contentMap` localized
 *     variant (empty top-level `content`) stored a blank `type:'text'` post, and
 *   - a media-only post whose only attachment was dropped as permanently
 *     unavailable stored a blank post too.
 *
 * The fix centralized extraction in `buildFederatedNoteContent`
 * (`connectors/activitypub/apPostContent.ts`), which this script reuses to REPAIR
 * the already-stored blanks: it re-fetches each empty federated post's source AP
 * object and rebuilds the body. When the source still has content, the post's
 * body/media/hashtags/type/CW are rewritten in place; when the source is gone
 * (404/410) or genuinely empty, the blank post is deleted. Transient fetch
 * failures leave the post untouched so a later re-run can still recover it.
 *
 * Idempotent (a repaired post no longer matches the empty-body filter), batched
 * via a stable ascending `_id` cursor (forward-only: both repair and delete
 * remove a post from the matching set going forward), and logs a final summary.
 *
 * Optional `--actor <actorUri>` restricts the run to a single federated actor —
 * run it as a canary against one actor before a full sweep, e.g.:
 *   bun packages/backend/dist/src/scripts/reingestEmptyFederatedPosts.js --actor https://masto.es/users/alvizlo
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/reingestEmptyFederatedPosts.js
 */

import mongoose from 'mongoose';
import { PostType } from '@mention/shared-types';
import { Post } from '../models/Post';
import { logger } from '../utils/logger';
import { buildFederatedNoteContent } from '../connectors/activitypub/apPostContent';
import { signedFetch } from '../connectors/activitypub/helpers';
import { AP_CONTENT_TYPE } from '../connectors/activitypub/constants';

/** Posts scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** HTTP statuses that mean the remote object is permanently gone. */
const GONE_STATUS_CODES = new Set([404, 410]);

interface EmptyFederatedPostRow {
  _id: mongoose.Types.ObjectId;
  oxyUserId?: string | null;
  federation?: {
    activityId?: string;
    actorUri?: string;
    url?: string;
  } | null;
}

/** Outcome of re-fetching a post's source AP object. */
type FetchOutcome =
  | { kind: 'ok'; object: Record<string, unknown> }
  | { kind: 'gone' }
  | { kind: 'error' };

/**
 * Re-fetch a federated post's source AP object, classifying the result so the
 * caller can distinguish a permanently-removed object (delete) from a transient
 * failure (leave in place for a later run). Follows redirects (default fetch
 * behavior) so a status permalink that 30x-redirects to the canonical object id
 * still resolves.
 */
async function fetchSourceObject(url: string): Promise<FetchOutcome> {
  let res: Response;
  try {
    res = await signedFetch(url, AP_CONTENT_TYPE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[reingestEmptyFederatedPosts] fetch error for ${url}: ${message}`);
    return { kind: 'error' };
  }

  if (GONE_STATUS_CODES.has(res.status)) return { kind: 'gone' };
  if (!res.ok) {
    logger.warn(`[reingestEmptyFederatedPosts] fetch failed for ${url}: ${res.status} ${res.statusText}`);
    return { kind: 'error' };
  }

  try {
    // `res.json()` is typed `any`; keep it `unknown` and narrow after validation
    // so no `any` leaks into the caller.
    const object: unknown = await res.json();
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
      logger.warn(`[reingestEmptyFederatedPosts] fetch returned non-object for ${url}`);
      return { kind: 'error' };
    }
    return { kind: 'ok', object: object as Record<string, unknown> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[reingestEmptyFederatedPosts] parse error for ${url}: ${message}`);
    return { kind: 'error' };
  }
}

/** Parse `--actor <uri>` / `--actor=<uri>` from argv. */
function parseActorArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--actor') return argv[i + 1];
    if (arg.startsWith('--actor=')) return arg.slice('--actor='.length);
  }
  return undefined;
}

/**
 * Build the Mongo filter selecting federated posts with an empty body: a
 * non-boost federated post with no text, no media, no attachments, and no poll.
 * `{ field: null }` matches both an explicit null and a missing field.
 */
function buildEmptyFederatedFilter(actorUri: string | undefined): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    'federation.activityId': { $exists: true, $ne: null },
    type: { $ne: PostType.BOOST },
    // No poll of any shape.
    'content.poll': null,
    'content.pollId': null,
    pollId: null,
    // Empty text AND empty media AND empty attachments.
    $and: [
      {
        $or: [
          { 'content.text': { $exists: false } },
          { 'content.text': null },
          { 'content.text': { $regex: /^\s*$/ } },
        ],
      },
      {
        $or: [
          { 'content.media': { $exists: false } },
          { 'content.media': null },
          { 'content.media': { $size: 0 } },
        ],
      },
      {
        $or: [
          { 'content.attachments': { $exists: false } },
          { 'content.attachments': null },
          { 'content.attachments': { $size: 0 } },
        ],
      },
    ],
  };
  if (actorUri) filter['federation.actorUri'] = actorUri;
  return filter;
}

async function reingestEmptyFederatedPosts(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;
  const actorUri = parseActorArg(process.argv.slice(2));

  const counts = { scanned: 0, recovered: 0, keptCwOnly: 0, deleted: 0, leftTransient: 0, skippedNoUrl: 0 };

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(
      `[reingestEmptyFederatedPosts] connected to MongoDB (${dbName})${actorUri ? ` — actor filter: ${actorUri}` : ''}`,
    );

    const baseFilter = buildEmptyFederatedFilter(actorUri);
    const totalCount = await Post.countDocuments(baseFilter);
    logger.info(`[reingestEmptyFederatedPosts] ${totalCount} empty federated posts to scan`);
    if (totalCount === 0) {
      logger.info('[reingestEmptyFederatedPosts] nothing to do');
      await mongoose.disconnect();
      return;
    }

    let lastId: mongoose.Types.ObjectId | null = null;

    // Forward-only cursor. Repair (rewrites content.text) and delete both remove
    // a post from the matching set for subsequent pages, and we only ever page by
    // ascending `_id`, so no post is visited twice and none is skipped.
    for (;;) {
      const pageFilter: Record<string, unknown> = { ...baseFilter };
      if (lastId) pageFilter._id = { $gt: lastId };

      const page = await Post.find(pageFilter, { _id: 1, oxyUserId: 1, federation: 1 })
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean<EmptyFederatedPostRow[]>();

      if (page.length === 0) break;

      for (const post of page) {
        counts.scanned += 1;
        const sourceUrl = post.federation?.url || post.federation?.activityId;
        if (!sourceUrl) {
          counts.skippedNoUrl += 1;
          continue;
        }

        const outcome = await fetchSourceObject(sourceUrl);

        if (outcome.kind === 'error') {
          // Transient failure — leave the post so a re-run can still recover it.
          counts.leftTransient += 1;
          continue;
        }

        if (outcome.kind === 'gone') {
          await Post.deleteOne({ _id: post._id });
          counts.deleted += 1;
          continue;
        }

        const built = await buildFederatedNoteContent(outcome.object, post.oxyUserId ?? null, {
          activityId: post.federation?.activityId,
          actorUri: post.federation?.actorUri,
        });

        if (built.skip) {
          // Source object carries nothing storable — the blank post is unrecoverable.
          await Post.deleteOne({ _id: post._id });
          counts.deleted += 1;
          continue;
        }

        const hasBody = built.text.trim().length > 0 || built.media.length > 0;
        const derivedType = built.media.length > 0
          ? (built.media.some((m) => m.type === 'video') ? PostType.VIDEO : PostType.IMAGE)
          : PostType.TEXT;

        const setOps: Record<string, unknown> = {
          'content.text': built.text,
          type: derivedType,
          hashtags: built.hashtags,
          'metadata.isSensitive': built.sensitive,
          'federation.sensitive': built.sensitive,
        };
        const unsetOps: Record<string, ''> = {};

        if (built.media.length > 0) setOps['content.media'] = built.media;
        else unsetOps['content.media'] = '';
        if (built.attachments.length > 0) setOps['content.attachments'] = built.attachments;
        else unsetOps['content.attachments'] = '';
        if (built.summary !== undefined) setOps['federation.spoilerText'] = built.summary;
        else unsetOps['federation.spoilerText'] = '';

        const update: Record<string, unknown> = { $set: setOps };
        if (Object.keys(unsetOps).length > 0) update.$unset = unsetOps;
        await Post.updateOne({ _id: post._id }, update);

        if (hasBody) counts.recovered += 1;
        else counts.keptCwOnly += 1;
      }

      lastId = page[page.length - 1]._id;
      logger.info(
        `[reingestEmptyFederatedPosts] progress: scanned ${counts.scanned}/${totalCount}, ` +
          `recovered ${counts.recovered}, keptCwOnly ${counts.keptCwOnly}, deleted ${counts.deleted}, ` +
          `leftTransient ${counts.leftTransient}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[reingestEmptyFederatedPosts] done: scanned ${counts.scanned}, recovered ${counts.recovered}, ` +
        `keptCwOnly ${counts.keptCwOnly}, deleted ${counts.deleted}, leftTransient ${counts.leftTransient}, ` +
        `skippedNoUrl ${counts.skippedNoUrl} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[reingestEmptyFederatedPosts] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis connections, media
  // cache workers) can keep the event loop alive, so the process would otherwise
  // sit RUNNING after the work completes. Mirrors recomputeFederatedEngagement.
  reingestEmptyFederatedPosts()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[reingestEmptyFederatedPosts] unhandled failure', error);
      process.exit(1);
    });
}

export default reingestEmptyFederatedPosts;
