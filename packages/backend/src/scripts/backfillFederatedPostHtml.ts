/**
 * One-shot admin backfill: re-emit AP `Update(Note)` for a SINGLE local user's
 * ALREADY-federated original posts so remote instances (Mastodon et al.)
 * re-render them with the now-corrected HTML body.
 *
 * Context: for months the outbound Note builder emitted the plain-text body as-is,
 * so Mastodon collapsed the author's blank lines / line breaks into a single run.
 * That is now fixed (`plainTextToApHtml` + the `buildCreateNoteActivity` /
 * `buildNoteContentMap` change), so `buildUpdateNoteActivity` already produces the
 * right HTML. A re-`Create` cannot repair the historical posts — Mastodon dedupes
 * an incoming object by its `id` and ignores a second Create for one it already has
 * — but an `Update` IS processed as an edit and re-renders the status. This script
 * pushes exactly that Update for the affected posts.
 *
 * It reuses the SAME delivery path the live edit flow calls
 * (`followService.federateUpdate`, which builds the `Update(Note)` via
 * `buildUpdateNoteActivity` and delivers via `deliverToFollowers`), so behavior is
 * byte-identical to a real edit — no hand-rolled Update/signing/delivery path.
 *
 * SELECTION (in order):
 *  1. The same base scope as `redeliverUserPosts`: the owner's local-origin,
 *     published, PUBLIC, top-level (non-reply) ORIGINAL posts — no boosts — sorted
 *     OLDEST-FIRST and capped at `BACKFILL_MAX` (overflow skipped, never blasted).
 *  2. THEN, of that capped set, ONLY the posts whose PRIMARY author-variant body
 *     contains a line break (`\n`). A single-line post renders identically whether
 *     it federates as raw text or as `<p>text</p>`, so Updating it would add a
 *     pointless "edited" mark on Mastodon for zero visible change. The primary body
 *     is read through the SAME resolver the Note builder uses (`resolveVariant`),
 *     never by hand-indexing `variants[0]`.
 *
 * SAFETY (in order):
 *  1. The target user id is REQUIRED (`BACKFILL_OXY_USER_ID` env or argv[2]).
 *     Missing/empty → exit(1) BEFORE any DB connect. NEVER defaults to all users.
 *  2. `BACKFILL_DRY_RUN` defaults to `'true'` (safe): logs what WOULD be updated
 *     and sends nothing. Only `BACKFILL_DRY_RUN=false` delivers.
 *  3. `BACKFILL_MAX` (default 500) caps the base set; overflow is skipped.
 *  4. Refuses to run when `FEDERATION_ENABLED` is false or the owner's
 *     `fediverseSharing` consent is off.
 *
 * Runnable as a Fargate one-shot:
 *   BACKFILL_OXY_USER_ID=6981c9178fcdefaf81988ffb \
 *   BACKFILL_DRY_RUN=false \
 *   bun packages/backend/dist/src/scripts/backfillFederatedPostHtml.js
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import FederatedFollow from '../models/FederatedFollow';
import FederatedActor from '../models/FederatedActor';
import { followService, type NoteSourcePost } from '../connectors/activitypub/follow.service';
import { FEDERATION_ENABLED } from '../connectors/activitypub/constants';
import { isFediverseSharingEnabled } from '../services/fediverseSharing';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { resolveVariant } from '../services/postVariants';
import { PostVisibility } from '@mention/shared-types';
import { logger } from '../utils/logger';

/** Default delay between deliveries (ms) — throttles the blast to avoid tripping mastodon.social rate limits. */
const DEFAULT_DELAY_MS = 2000;

/** Default safety cap on how many posts a single run may scan/update. */
const DEFAULT_MAX = 500;

/**
 * Grace period to let the awaited-but-detached delivery/enqueue work flush before
 * the process disconnects and exits. `federateUpdate` awaits its follower enqueue,
 * so a short settle is plenty; mirrors the other one-shot federation scripts.
 */
const DELIVERY_SETTLE_MS = 5000;

/** Characters of the primary body echoed in dry-run / per-post log lines. */
const SNIPPET_MAX_CHARS = 80;

/** The lean Post shape delivery needs — structurally satisfies `federateUpdate`. */
type BackfillablePost = NoteSourcePost & { visibility: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a strictly-positive integer env value, falling back on absent/invalid input. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The post's PRIMARY plain-text body, resolved through the EXACT resolver the Note
 * builder uses (`resolveVariant(post.content)` → `.text`, the string that becomes
 * `content` after `plainTextToApHtml`). Never hand-indexes `variants[0]`. Returns
 * `''` if the body cannot be resolved (defensive — such a post has no detectable
 * line break and is simply excluded).
 */
function primaryBodyOf(post: BackfillablePost): string {
  try {
    return resolveVariant(post.content).text ?? '';
  } catch {
    return '';
  }
}

/**
 * Whether an Update would actually change how the post renders on Mastodon: only
 * true when the primary body carries a line break. A single-line body is identical
 * as raw text and as `<p>text</p>`, so Updating it only stamps a spurious edit.
 */
function hasMeaningfulLineBreak(post: BackfillablePost): boolean {
  return primaryBodyOf(post).includes('\n');
}

/** One-line body preview (whitespace collapsed, truncated) for logging. */
function snippetOf(post: BackfillablePost): string {
  const collapsed = primaryBodyOf(post).replace(/\s+/g, ' ').trim();
  return collapsed.length > SNIPPET_MAX_CHARS ? `${collapsed.slice(0, SNIPPET_MAX_CHARS)}…` : collapsed;
}

/** ISO timestamp for logging, tolerant of a Date or string `createdAt`. */
function formatCreatedAt(createdAt: string | Date): string {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  return Number.isNaN(date.getTime()) ? String(createdAt) : date.toISOString();
}

/**
 * Resolve the target's remote follower inboxes for REPORTING only (the header and
 * dry-run output). This mirrors the exact ownership query `deliverToFollowers`
 * uses — accepted inbound `FederatedFollow`s → `FederatedActor` shared/personal
 * inbox, deduped by shared inbox — but never sends anything itself. Actual
 * delivery goes through `federateUpdate` (which re-runs this resolution). Not a
 * second delivery/signing path; purely read-only enumeration for the operator.
 */
async function resolveFollowerInboxes(
  oxyUserId: string,
): Promise<{ followerCount: number; inboxes: string[] }> {
  const follows = await FederatedFollow.find(
    { localUserId: oxyUserId, direction: 'inbound', status: 'accepted' },
    { remoteActorUri: 1 },
  ).lean<{ remoteActorUri: string }[]>();

  const actorUris = follows.map((f) => f.remoteActorUri);
  const actors =
    actorUris.length > 0
      ? await FederatedActor.find(
          { uri: { $in: actorUris } },
          { uri: 1, sharedInboxUrl: 1, inboxUrl: 1 },
        ).lean<{ uri: string; sharedInboxUrl?: string; inboxUrl?: string }[]>()
      : [];

  const seen = new Set<string>();
  const inboxes: string[] = [];
  for (const actor of actors) {
    const inbox = actor.sharedInboxUrl || actor.inboxUrl;
    if (inbox && !seen.has(inbox)) {
      seen.add(inbox);
      inboxes.push(inbox);
    }
  }
  return { followerCount: follows.length, inboxes };
}

async function backfillFederatedPostHtml(): Promise<void> {
  const startedAt = Date.now();

  // 1. PRIMARY SAFETY: an explicit target is mandatory. Never default to a broad
  //    or unscoped run.
  const targetUserId = (process.env.BACKFILL_OXY_USER_ID || process.argv[2] || '').trim();
  if (!targetUserId) {
    logger.error(
      '[backfillFederatedPostHtml] BACKFILL_OXY_USER_ID is required (or pass the id as argv). Refusing to run unscoped.',
    );
    process.exit(1);
  }

  // Federation off → `federateUpdate` no-ops, so there is nothing to re-emit. Fail
  // loudly rather than silently "succeeding" on zero work.
  if (!FEDERATION_ENABLED) {
    logger.error('[backfillFederatedPostHtml] FEDERATION_ENABLED is false; nothing to update. Aborting.');
    process.exit(1);
  }

  const dryRun = process.env.BACKFILL_DRY_RUN !== 'false';
  const delayMs = parsePositiveInt(process.env.BACKFILL_DELAY_MS, DEFAULT_DELAY_MS);
  const maxPosts = parsePositiveInt(process.env.BACKFILL_MAX, DEFAULT_MAX);

  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  await mongoose.connect(mongoUri, { dbName });
  logger.info(`[backfillFederatedPostHtml] connected to MongoDB (${dbName})`);

  try {
    // Resolve the owner username SERVER-SIDE from the authoritative oxyUserId (the
    // same mechanism the live delivery path uses). No username → cannot build a
    // canonical actor/Note; refuse.
    const owner = await getServiceOxyClient().getUserById(targetUserId);
    const username = owner.username?.trim();
    if (!username) {
      throw new Error(`no resolvable Oxy username for user ${targetUserId}; cannot federate`);
    }

    // Respect the owner's fediverse-sharing consent — never blast when sharing is
    // off. (`federateUpdate` re-checks this too; we refuse up-front so the whole
    // run is a clear no-op instead of silently dropping every post.)
    const sharingEnabled = await isFediverseSharingEnabled(targetUserId);
    if (!sharingEnabled) {
      throw new Error(
        `fediverseSharing is OFF for ${targetUserId} (@${username}); refusing to update posts`,
      );
    }

    // Follower inboxes (reporting only). Zero remote inboxes → genuinely nothing to
    // deliver to; report and exit cleanly.
    const { followerCount, inboxes } = await resolveFollowerInboxes(targetUserId);
    if (inboxes.length === 0) {
      logger.warn(
        `[backfillFederatedPostHtml] @${username} (${targetUserId}) has no remote follower inboxes; nothing to update. Done.`,
      );
      return;
    }

    // 2. BASE SCOPE: the owner's local-origin, published, PUBLIC, top-level
    //    (non-reply) ORIGINAL posts — no boosts. Identical to the redeliver script.
    const postFilter = {
      oxyUserId: targetUserId,
      federation: null, // local origin (missing or null federation subdoc)
      status: 'published',
      visibility: PostVisibility.PUBLIC,
      parentPostId: null, // top-level only — EXCLUDE replies
      boostOf: null, // not a boost (mirrors native repost exclusion)
      type: { $ne: 'boost' },
    } as const;

    const totalMatched = await Post.countDocuments(postFilter);

    // SAFETY CAP: never scan an unbounded set. Take the OLDEST `maxPosts`; the rest
    // (the newest) are skipped by the cap and reported.
    const willScan = Math.min(totalMatched, maxPosts);
    const cappedSkipped = totalMatched - willScan;
    if (cappedSkipped > 0) {
      logger.warn(
        `[backfillFederatedPostHtml] matched ${totalMatched} posts exceeds BACKFILL_MAX=${maxPosts}; scanning the oldest ${maxPosts}, skipping ${cappedSkipped}.`,
      );
    }

    const scanned = await Post.find(postFilter)
      .sort({ createdAt: 1, _id: 1 })
      .limit(maxPosts)
      .lean<BackfillablePost[]>();

    // LINE-BREAK FILTER: of the scanned set, keep only posts whose primary body
    // actually has a line break — the ONLY posts whose rendering an Update fixes.
    const posts = scanned.filter(hasMeaningfulLineBreak);
    const excludedNoLineBreak = scanned.length - posts.length;

    // Header.
    logger.info('[backfillFederatedPostHtml] ===== HTML re-render (Update) plan =====');
    logger.info(`[backfillFederatedPostHtml] target user:       ${targetUserId} (@${username})`);
    logger.info(`[backfillFederatedPostHtml] remote followers:  ${followerCount} (${inboxes.length} distinct inboxes)`);
    for (const inbox of inboxes) {
      logger.info(`[backfillFederatedPostHtml]   inbox: ${inbox}`);
    }
    logger.info(`[backfillFederatedPostHtml] mode:              ${dryRun ? 'DRY-RUN (sending nothing)' : 'LIVE (delivering)'}`);
    logger.info(`[backfillFederatedPostHtml] delay between:     ${delayMs}ms`);
    logger.info(`[backfillFederatedPostHtml] cap:               ${maxPosts}`);
    logger.info(
      `[backfillFederatedPostHtml] matched w/ breaks: ${posts.length} of ${scanned.length} scanned ` +
        `(${excludedNoLineBreak} excluded: no line break, ${cappedSkipped} skipped by cap of ${totalMatched} matched)`,
    );
    logger.info('[backfillFederatedPostHtml] ========================================');

    let updated = 0;
    let failed = 0;

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const postId = String(post._id);
      const position = `${i + 1}/${posts.length}`;
      const createdAt = formatCreatedAt(post.createdAt);
      const snippet = snippetOf(post);

      if (dryRun) {
        logger.info(
          `[backfillFederatedPostHtml] [${position}] WOULD update post ${postId} (createdAt=${createdAt}) → ${inboxes.length} inbox(es) | "${snippet}"`,
        );
        continue;
      }

      try {
        // Reuse the EXACT live edit path: builds the `Update(Note)` via
        // `buildUpdateNoteActivity` (with the corrected HTML body) and delivers via
        // `deliverToFollowers`. It re-gates on FEDERATION_ENABLED + sharing +
        // non-boost + PUBLIC internally, so behavior is identical to a real edit.
        await followService.federateUpdate(post, targetUserId, username);
        updated += 1;
        logger.info(
          `[backfillFederatedPostHtml] [${position}] updated post ${postId} (createdAt=${createdAt}) | "${snippet}"`,
        );
      } catch (err) {
        // Count and CONTINUE — one bad post never aborts the whole run.
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[backfillFederatedPostHtml] [${position}] FAILED post ${postId}: ${message}`);
      }

      // Throttle between deliveries (never after the last).
      if (i < posts.length - 1) {
        await sleep(delayMs);
      }
    }

    if (!dryRun && updated > 0) {
      // Let the awaited-but-detached follower enqueue/delivery work flush before
      // tearing down the connection.
      await sleep(DELIVERY_SETTLE_MS);
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (dryRun) {
      logger.info(
        `[backfillFederatedPostHtml] DRY-RUN done: ${posts.length} posts WOULD be updated to ${inboxes.length} inbox(es); ` +
          `${excludedNoLineBreak} excluded (no line break), ${cappedSkipped} skipped by cap (${elapsedSeconds}s). ` +
          'Set BACKFILL_DRY_RUN=false to actually deliver.',
      );
    } else {
      logger.info(
        `[backfillFederatedPostHtml] done: updated ${updated}, failed ${failed}, ` +
          `excluded ${excludedNoLineBreak} (no line break), skipped ${cappedSkipped} by cap ` +
          `of ${totalMatched} matched (${elapsedSeconds}s).`,
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis connection, media
  // cache workers) keep the event loop alive, so the process would otherwise sit
  // RUNNING after the work completes. Mirrors the other federation one-shots.
  backfillFederatedPostHtml()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillFederatedPostHtml] unhandled failure', error);
      process.exit(1);
    });
}

export default backfillFederatedPostHtml;
