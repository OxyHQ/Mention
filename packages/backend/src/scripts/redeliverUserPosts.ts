/**
 * One-shot admin backfill: re-deliver a SINGLE local user's existing original
 * posts to their remote fediverse followers.
 *
 * Context: the outbound `Create(Note)` fan-out was broken for months (now fixed),
 * so this user's historical posts never reached their remote followers. Mastodon
 * does not backfill timelines, so the account owner explicitly requested a
 * one-time push of their old posts. This is inherently a spam-ish blast, so it is
 * TIGHTLY scoped (one explicit user, top-level public originals only) and
 * throttled (a configurable delay between posts). It reuses the SAME delivery path
 * the live create path calls (`followService.federateNewPost`, which builds the
 * Create(Note) via `buildCreateNoteActivity` and delivers via `deliverToFollowers`)
 * so behavior is byte-identical to a freshly created post — no hand-rolled
 * signing/delivery path.
 *
 * SAFETY (in order):
 *  1. The target user id is REQUIRED (`REDELIVER_OXY_USER_ID` env or argv[2]).
 *     Missing/empty → exit(1). NEVER defaults to all users / unscoped.
 *  2. `REDELIVER_DRY_RUN` defaults to `'true'` (safe): logs what WOULD be
 *     delivered and sends nothing. Only `REDELIVER_DRY_RUN=false` delivers.
 *  3. `REDELIVER_MAX` (default 500) caps the set; overflow is skipped, never
 *     silently blasted.
 *  4. Refuses to run when `FEDERATION_ENABLED` is false or the owner's
 *     `fediverseSharing` consent is off.
 *
 * Runnable as a Fargate one-shot:
 *   REDELIVER_OXY_USER_ID=6981c9178fcdefaf81988ffb \
 *   REDELIVER_DRY_RUN=false \
 *   bun packages/backend/dist/src/scripts/redeliverUserPosts.js
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

/** Default safety cap on how many posts a single run may re-deliver. */
const DEFAULT_MAX = 500;

/**
 * Grace period to let the awaited-but-detached delivery/enqueue work flush before
 * the process disconnects and exits. `federateNewPost` awaits its follower
 * enqueue, so a short settle is plenty; mirrors the other one-shot federation
 * scripts.
 */
const DELIVERY_SETTLE_MS = 5000;

/** Characters of the primary body echoed in dry-run / per-post log lines. */
const SNIPPET_MAX_CHARS = 80;

/** The lean Post shape delivery needs — structurally satisfies `federateNewPost`. */
type RedeliverablePost = NoteSourcePost & { visibility: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a strictly-positive integer env value, falling back on absent/invalid input. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** One-line body preview (whitespace collapsed, truncated) for logging. */
function snippetOf(post: RedeliverablePost): string {
  let text = '';
  try {
    text = resolveVariant(post.content).text ?? '';
  } catch {
    text = '';
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
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
 * delivery goes through `federateNewPost` (which re-runs this resolution). Not a
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

async function redeliverUserPosts(): Promise<void> {
  const startedAt = Date.now();

  // 1. PRIMARY SAFETY: an explicit target is mandatory. Never default to a broad
  //    or unscoped run.
  const targetUserId = (process.env.REDELIVER_OXY_USER_ID || process.argv[2] || '').trim();
  if (!targetUserId) {
    logger.error(
      '[redeliverUserPosts] REDELIVER_OXY_USER_ID is required (or pass the id as argv). Refusing to run unscoped.',
    );
    process.exit(1);
  }

  // Federation off → `federateNewPost` no-ops, so re-delivery is impossible. Fail
  // loudly rather than silently "succeeding" on zero work.
  if (!FEDERATION_ENABLED) {
    logger.error('[redeliverUserPosts] FEDERATION_ENABLED is false; nothing to deliver. Aborting.');
    process.exit(1);
  }

  const dryRun = process.env.REDELIVER_DRY_RUN !== 'false';
  const delayMs = parsePositiveInt(process.env.REDELIVER_DELAY_MS, DEFAULT_DELAY_MS);
  const maxPosts = parsePositiveInt(process.env.REDELIVER_MAX, DEFAULT_MAX);

  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  await mongoose.connect(mongoUri, { dbName });
  logger.info(`[redeliverUserPosts] connected to MongoDB (${dbName})`);

  try {
    // 2. Resolve the owner username SERVER-SIDE from the authoritative oxyUserId
    //    (the same mechanism the live delivery path uses). No username → cannot
    //    build a canonical actor/Note; refuse.
    const owner = await getServiceOxyClient().getUserById(targetUserId);
    const username = owner.username?.trim();
    if (!username) {
      throw new Error(`no resolvable Oxy username for user ${targetUserId}; cannot federate`);
    }

    // 3. Respect the owner's fediverse-sharing consent — never blast when sharing
    //    is off. (`federateNewPost` re-checks this too; we refuse up-front so the
    //    whole run is a clear no-op instead of silently dropping every post.)
    const sharingEnabled = await isFediverseSharingEnabled(targetUserId);
    if (!sharingEnabled) {
      throw new Error(
        `fediverseSharing is OFF for ${targetUserId} (@${username}); refusing to re-deliver posts`,
      );
    }

    // Follower inboxes (reporting only). Zero remote inboxes → genuinely nothing
    // to deliver to; report and exit cleanly.
    const { followerCount, inboxes } = await resolveFollowerInboxes(targetUserId);
    if (inboxes.length === 0) {
      logger.warn(
        `[redeliverUserPosts] @${username} (${targetUserId}) has no remote follower inboxes; nothing to deliver. Done.`,
      );
      return;
    }

    // 2. SCOPE: the owner's local-origin, published, PUBLIC, top-level (non-reply)
    //    ORIGINAL posts — no boosts. Sorted OLDEST-FIRST so delivery order is
    //    chronological. Mirrors the ownership/visibility filter the outbox route
    //    (`/ap/users/:username/outbox`) uses, plus the explicit local-origin +
    //    not-a-boost guards this backfill requires.
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

    // 6. SAFETY CAP: never silently blast an unbounded set. Process the first
    //    `maxPosts` (oldest) and report the rest as skipped.
    const willProcess = Math.min(totalMatched, maxPosts);
    const skipped = totalMatched - willProcess;
    if (skipped > 0) {
      logger.warn(
        `[redeliverUserPosts] matched ${totalMatched} posts exceeds REDELIVER_MAX=${maxPosts}; processing the oldest ${maxPosts}, skipping ${skipped}.`,
      );
    }

    const posts = await Post.find(postFilter)
      .sort({ createdAt: 1, _id: 1 })
      .limit(maxPosts)
      .lean<RedeliverablePost[]>();

    // 7. Header.
    logger.info('[redeliverUserPosts] ===== re-delivery plan =====');
    logger.info(`[redeliverUserPosts] target user:      ${targetUserId} (@${username})`);
    logger.info(`[redeliverUserPosts] remote followers: ${followerCount} (${inboxes.length} distinct inboxes)`);
    for (const inbox of inboxes) {
      logger.info(`[redeliverUserPosts]   inbox: ${inbox}`);
    }
    logger.info(`[redeliverUserPosts] mode:             ${dryRun ? 'DRY-RUN (sending nothing)' : 'LIVE (delivering)'}`);
    logger.info(`[redeliverUserPosts] delay between:    ${delayMs}ms`);
    logger.info(`[redeliverUserPosts] cap:              ${maxPosts}`);
    logger.info(`[redeliverUserPosts] matched:          ${totalMatched} (processing ${posts.length}, skipping ${skipped})`);
    logger.info('[redeliverUserPosts] ============================');

    let delivered = 0;
    let failed = 0;

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const postId = String(post._id);
      const position = `${i + 1}/${posts.length}`;
      const createdAt = formatCreatedAt(post.createdAt);
      const snippet = snippetOf(post);

      if (dryRun) {
        logger.info(
          `[redeliverUserPosts] [${position}] WOULD deliver post ${postId} (createdAt=${createdAt}) → ${inboxes.length} inbox(es) | "${snippet}"`,
        );
        continue;
      }

      try {
        // Reuse the EXACT live delivery path: builds the Create(Note) via
        // `buildCreateNoteActivity` and delivers via `deliverToFollowers`. It
        // gates on FEDERATION_ENABLED + sharing internally and, for these
        // top-level public originals, fans out to the owner's remote followers.
        await followService.federateNewPost(post, targetUserId, username);
        delivered += 1;
        logger.info(
          `[redeliverUserPosts] [${position}] delivered post ${postId} (createdAt=${createdAt}) | "${snippet}"`,
        );
      } catch (err) {
        // Count and CONTINUE — one bad post never aborts the whole run.
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[redeliverUserPosts] [${position}] FAILED post ${postId}: ${message}`);
      }

      // Throttle between deliveries (never after the last).
      if (i < posts.length - 1) {
        await sleep(delayMs);
      }
    }

    if (!dryRun && delivered > 0) {
      // Let the awaited-but-detached follower enqueue/delivery work flush before
      // tearing down the connection.
      await sleep(DELIVERY_SETTLE_MS);
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (dryRun) {
      logger.info(
        `[redeliverUserPosts] DRY-RUN done: ${posts.length} posts WOULD be delivered to ${inboxes.length} inbox(es), ${skipped} skipped by cap (${elapsedSeconds}s). Set REDELIVER_DRY_RUN=false to actually deliver.`,
      );
    } else {
      logger.info(
        `[redeliverUserPosts] done: delivered ${delivered}, failed ${failed}, skipped ${skipped} of ${totalMatched} matched (${elapsedSeconds}s).`,
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
  redeliverUserPosts()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[redeliverUserPosts] unhandled failure', error);
      process.exit(1);
    });
}

export default redeliverUserPosts;
