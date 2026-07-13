/**
 * One-shot remediation: backfill the missing Oxy author link on LEGACY federated
 * "orphan" posts.
 *
 * BACKGROUND
 * ----------
 * A federated post is authored by a federated actor whose identity is bridged to
 * an Oxy user (`oxyUserId`, denormalized onto the post + its `authorship[]`). The
 * CURRENT ingest paths (`ensureFederatedNote`, `handleCreate`, `syncOutboxPosts`)
 * REQUIRE a resolved author and SKIP otherwise, so no NEW orphans are created.
 * But a cohort of LEGACY posts (ingested before that invariant) carry
 * `oxyUserId: null` — they are invisible in author feeds and render blank when a
 * boost/quote references them. Phase 1 made hydration render such posts in a
 * DEGRADED form (federation-derived author, so nothing is blank); THIS script is
 * the remediation that restores their REAL author link.
 *
 * PER-ORPHAN ALGORITHM
 * --------------------
 * For each post with `federation.activityId` set and `oxyUserId == null`:
 *   1. Determine the author actor URI:
 *        - use `federation.actorUri` when present (no network); else
 *        - re-fetch the AP object by `federation.activityId` (falling back to
 *          `federation.url`) and read `attributedTo`. This covers brid.gy /
 *          Bluesky-bridged notes, which arrive over ActivityPub (brid.gy is an AP
 *          bridge) and whose actor is a normal AP actor — so the SAME
 *          `actorService` path resolves them; the atproto connector is NOT
 *          involved (that is READ/discovery of NATIVE bsky, and our own outbound
 *          be-discovered bridge — both unrelated to inbound bridged content).
 *   2. Resolve the actor URI → `oxyUserId` via `actorService.getOrFetchActor`,
 *      forcing a full `fetchRemoteActor` (which mints/refreshes the Oxy user via
 *      the shared `resolveOxyExternalUser` identity bridge) when a cached actor
 *      row exists but was never linked. Repeated actors are resolved once
 *      (in-memory cache) — the 11,967 orphans come from far fewer actors.
 *   3. On success: set the post's `oxyUserId` + `authorship` (`buildAuthorship`)
 *      and backfill `federation.actorUri` when it was missing. `updateOne` does
 *      NOT run the Post pre-save hook, so BOTH fields are written explicitly and
 *      stay in lockstep (the same shape the hook would produce).
 *   4. DELETE the post ONLY when its source is definitively gone (HTTP 404/410)
 *      AND no author could be resolved. A transient failure (timeout, 5xx, 401/403
 *      signature rejection, SSRF-blocked, no `attributedTo`) is LEFT UNTOUCHED for
 *      a later re-run — never deleted.
 *
 * SAFETY / OPERATION
 * ------------------
 * Idempotent (a linked post leaves the `oxyUserId: null` set), batched via a
 * stable ascending `_id` cursor, bounded concurrency, best-effort per post (one
 * failure never aborts the run). Writes and deletes are OFF by default:
 *   - `BACKFILL_APPLY=true`   — actually write `oxyUserId`/`authorship`.
 *   - `BACKFILL_DELETE_GONE=true` — additionally allow deleting 404/410-gone posts.
 * With neither set the script is a pure DRY RUN that reports what it WOULD do.
 *
 * It makes signed remote fetches (instance key pair + service token), so run it
 * as a Fargate one-shot in the oxy-api SG/subnets, post-deploy:
 *   BACKFILL_APPLY=true node dist/scripts/backfillFederatedPostAuthors.js
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { actorService } from '../connectors/activitypub/actor.service';
import { extractActorUri, signedFetch, asRecord } from '../connectors/activitypub/helpers';
import { AP_CONTENT_TYPE } from '../connectors/activitypub/constants';
import { assertSafePublicUrl } from '../utils/ssrfGuard';
import { buildAuthorship } from '../utils/postAuthorship';
import { logger } from '../utils/logger';

/** Orphans scanned per page (stable ascending `_id` cursor). */
const PAGE_SIZE = 200;

/** Orphans resolved in parallel within a page (bounded to be polite to remotes). */
const CONCURRENCY = 4;

/** Write `oxyUserId`/`authorship` (else dry-run: report only). */
const APPLY = process.env.BACKFILL_APPLY === 'true';

/** Additionally allow deleting posts whose source is definitively gone (404/410). */
const DELETE_GONE = process.env.BACKFILL_DELETE_GONE === 'true';

interface OrphanRow {
  _id: mongoose.Types.ObjectId;
  federation?: { activityId?: string; actorUri?: string; url?: string };
}

/** The outcome of resolving one orphan's author actor URI. */
type AuthorUriResult =
  | { kind: 'ok'; authorUri: string; actorUriWasMissing: boolean }
  | { kind: 'gone' }
  | { kind: 'transient' };

/** actorUri → resolved oxyUserId (or null when unresolvable) — dedupes shared actors across the whole run. */
const actorOxyCache = new Map<string, string | null>();

/**
 * actorUri → in-flight resolution promise. The bulk of the 11,967 orphans come
 * from far fewer actors, so within a page-chunk MANY concurrent orphans share one
 * actor. `actorOxyCache` only dedupes AFTER a resolve settles, so without this two
 * concurrent orphans of the same actor both hit `/users/resolve` and RACE on
 * federated-user creation (observed as HTTP 409s in the dry run). Memoizing the
 * in-flight PROMISE collapses concurrent callers for one actor onto a SINGLE
 * resolve; the settled value then lands in `actorOxyCache` for the rest of the run.
 */
const inFlightActorResolves = new Map<string, Promise<string | null>>();

/**
 * Resolve an actor URI to its Oxy user id, minting/linking the federated Oxy user
 * when necessary. `getOrFetchActor` returns a cached row as-is (kicking only a
 * background refresh), so when that row has no `oxyUserId` we force an AWAITED
 * `fetchRemoteActor`, which runs the shared identity bridge and stamps the id.
 *
 * Concurrency-safe: a settled result is served from `actorOxyCache`; a concurrent
 * call for an actor already resolving awaits the SAME in-flight promise (no
 * duplicate `/users/resolve`, no 409 race).
 */
export async function resolveAuthorOxyUserId(actorUri: string): Promise<string | null> {
  const cached = actorOxyCache.get(actorUri);
  if (cached !== undefined) return cached;

  const inFlight = inFlightActorResolves.get(actorUri);
  if (inFlight) return inFlight;

  const resolution = (async (): Promise<string | null> => {
    let oxyUserId: string | null = null;
    try {
      const actor = await actorService.getOrFetchActor(actorUri);
      oxyUserId = actor?.oxyUserId ?? null;
      if (!oxyUserId) {
        const refreshed = await actorService.fetchRemoteActor(actorUri);
        oxyUserId = refreshed?.oxyUserId ?? null;
      }
    } catch (error) {
      logger.warn('[backfillFederatedPostAuthors] actor resolution failed', {
        actorUri,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
    actorOxyCache.set(actorUri, oxyUserId);
    return oxyUserId;
  })();

  inFlightActorResolves.set(actorUri, resolution);
  try {
    return await resolution;
  } finally {
    inFlightActorResolves.delete(actorUri);
  }
}

/**
 * Determine the author actor URI for an orphan: prefer the stored
 * `federation.actorUri`, otherwise re-fetch the AP object and read `attributedTo`.
 * Distinguishes a definitively-gone source (404/410) from a transient failure so
 * only truly-dead posts become deletion candidates.
 */
async function resolveOrphanAuthorUri(orphan: OrphanRow): Promise<AuthorUriResult> {
  const storedActorUri = orphan.federation?.actorUri;
  if (storedActorUri) {
    return { kind: 'ok', authorUri: storedActorUri, actorUriWasMissing: false };
  }

  const objectUrl = orphan.federation?.activityId || orphan.federation?.url;
  if (!objectUrl) return { kind: 'transient' };

  const guard = await assertSafePublicUrl(objectUrl);
  if (!guard.ok) return { kind: 'transient' };

  let res: Response;
  try {
    res = await signedFetch(objectUrl, AP_CONTENT_TYPE);
  } catch {
    return { kind: 'transient' };
  }

  if (res.status === 404 || res.status === 410) return { kind: 'gone' };
  if (!res.ok) return { kind: 'transient' };

  let note: Record<string, unknown> | null;
  try {
    note = asRecord(await res.json());
  } catch {
    return { kind: 'transient' };
  }

  const authorUri = extractActorUri(note?.attributedTo);
  if (!authorUri) return { kind: 'transient' };
  return { kind: 'ok', authorUri, actorUriWasMissing: true };
}

interface Counters {
  scanned: number;
  linked: number;
  deleted: number;
  unresolvedAuthor: number;
  transient: number;
}

/** Process one orphan; returns the counter bucket it fell into. */
async function processOrphan(orphan: OrphanRow): Promise<keyof Omit<Counters, 'scanned'>> {
  const uriResult = await resolveOrphanAuthorUri(orphan);

  if (uriResult.kind === 'transient') return 'transient';

  if (uriResult.kind === 'gone') {
    // Only delete when the source is gone AND no author is resolvable. There is no
    // actor URI to resolve here (a gone object yields none), so the post is dead.
    if (DELETE_GONE && APPLY) {
      await Post.deleteOne({ _id: orphan._id });
    }
    return 'deleted';
  }

  const oxyUserId = await resolveAuthorOxyUserId(uriResult.authorUri);
  if (!oxyUserId) return 'unresolvedAuthor';

  if (APPLY) {
    const set: Record<string, unknown> = {
      oxyUserId,
      authorship: buildAuthorship(oxyUserId, []),
    };
    // Backfill the actor URI when it was missing (brid.gy/Bluesky orphans) so the
    // Phase-1 degraded-render path can also enrich by URI next time.
    if (uriResult.actorUriWasMissing) {
      set['federation.actorUri'] = uriResult.authorUri;
    }
    await Post.updateOne({ _id: orphan._id }, { $set: set });
  }
  return 'linked';
}

async function backfillFederatedPostAuthors(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  const orphanFilter = {
    'federation.activityId': { $exists: true, $ne: null },
    oxyUserId: null,
  } as const;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(
      `[backfillFederatedPostAuthors] connected to MongoDB (${dbName}); APPLY=${APPLY} DELETE_GONE=${DELETE_GONE}`,
    );

    const totalCount = await Post.countDocuments(orphanFilter);
    logger.info(`[backfillFederatedPostAuthors] ${totalCount} orphan federated posts to scan`);
    if (totalCount === 0) {
      await mongoose.disconnect();
      return;
    }

    const counters: Counters = { scanned: 0, linked: 0, deleted: 0, unresolvedAuthor: 0, transient: 0 };
    let lastId: mongoose.Types.ObjectId | null = null;

    for (;;) {
      const pageFilter: Record<string, unknown> = { ...orphanFilter };
      if (lastId) pageFilter._id = { $gt: lastId };

      const page = await Post.find(pageFilter, { _id: 1, federation: 1 })
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean<OrphanRow[]>();

      if (page.length === 0) break;

      // Bounded-concurrency fan-out over the page. `lastId` advances past the whole
      // page, and mutating/deleting an already-scanned _id never affects the
      // forward cursor, so linked posts simply leave the set.
      for (let i = 0; i < page.length; i += CONCURRENCY) {
        const chunk = page.slice(i, i + CONCURRENCY);
        const buckets = await Promise.all(chunk.map((orphan) => processOrphan(orphan).catch((error) => {
          logger.warn('[backfillFederatedPostAuthors] orphan processing failed', {
            postId: String(orphan._id),
            reason: error instanceof Error ? error.message : 'unknown',
          });
          return 'transient' as const;
        })));
        for (const bucket of buckets) counters[bucket] += 1;
      }

      counters.scanned += page.length;
      lastId = page[page.length - 1]._id;
      logger.info(
        `[backfillFederatedPostAuthors] progress: scanned ${counters.scanned}/${totalCount}, ` +
          `linked ${counters.linked}, deleted ${counters.deleted}, ` +
          `unresolvedAuthor ${counters.unresolvedAuthor}, transient ${counters.transient}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillFederatedPostAuthors] done in ${elapsedSeconds}s: scanned ${counters.scanned}, ` +
        `linked ${counters.linked}, deleted ${counters.deleted}, ` +
        `unresolvedAuthor ${counters.unresolvedAuthor}, transient ${counters.transient}` +
        (APPLY ? '' : ' (DRY RUN — no writes)'),
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[backfillFederatedPostAuthors] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis, MediaCache workers)
  // otherwise keep the event loop alive after the work completes.
  backfillFederatedPostAuthors()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillFederatedPostAuthors] unhandled failure', error);
      process.exit(1);
    });
}

export default backfillFederatedPostAuthors;
